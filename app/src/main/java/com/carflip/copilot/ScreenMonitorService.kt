package com.carflip.copilot

import android.app.*
import android.content.Intent
import android.graphics.*
import android.media.*
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.provider.Settings
import android.view.*
import android.widget.TextView
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

class ScreenMonitorService : Service() {
    private lateinit var commandServer: CommandServer
    private lateinit var remotePoller: RemoteCommandPoller
    private lateinit var liveBridge: LiveBridge
    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var overlay: TextView? = null
    private var lastFrame: Bitmap? = null
    private var lastCapture = 0L
    private val stableOcr = StableOcr()
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
    private var frames = 0
    private var ocrSuccess = 0
    private var ocrAccepted = 0
    private var lastOcrChars = 0
    private var lastOcrAt = 0L
    private var lastOcrPreview = ""
    private var lastOcrError = ""
    private var captureReady = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        CopilotState.setMonitoring(this, false)
        createChannel()
        commandServer = CommandServer(this).also { it.start() }
        remotePoller = RemoteCommandPoller(this).also { it.start() }
        liveBridge = LiveBridge(this) { command -> handleCommand(command) }.also { it.start() }
        startForeground(
            10,
            Notification.Builder(this, "copilot")
                .setContentTitle("Перекуп Copilot")
                .setContentText("Ожидание разрешения захвата экрана")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .build()
        showOverlay()

        val code = intent?.getIntExtra("resultCode", Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        val data = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra("data", Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra<Intent>("data")
        }

        if (code != Activity.RESULT_OK || data == null) {
            lastOcrError = "Разрешение MediaProjection не получено"
            showOverlayDiagnostics(lastOcrError!!)
            CopilotState.addEvent(this, "CAPTURE • разрешение захвата не получено")
            return START_NOT_STICKY
        }

        try {
            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = manager.getMediaProjection(code, data)
            if (projection == null) {
                lastOcrError = "MediaProjection вернул null"
                showOverlayDiagnostics(lastOcrError!!)
                CopilotState.addEvent(this, "CAPTURE • MediaProjection=null")
                return START_NOT_STICKY
            }
            projection?.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    captureReady = false
                    CopilotState.setMonitoring(this@ScreenMonitorService, false)
                    lastOcrError = "Захват экрана остановлен Android"
                    CopilotState.addEvent(this@ScreenMonitorService, "CAPTURE • MediaProjection остановлен")
                    showOverlayDiagnostics(lastOcrError!!)
                }
            }, Handler(Looper.getMainLooper()))
            startCapture()
            if (captureReady) {
                CopilotState.setMonitoring(this, true)
                CopilotState.addEvent(this, "CAPTURE • MediaProjection готов • OCR запущен")
                showOverlayDiagnostics("Захват экрана запущен")
            }
        } catch (error: Exception) {
            lastOcrError = error.message ?: "ошибка запуска MediaProjection"
            CopilotState.setMonitoring(this, false)
            CopilotState.addEvent(this, "CAPTURE • ошибка запуска • $lastOcrError")
            showOverlayDiagnostics("CAPTURE ERROR: $lastOcrError")
        }
        return START_NOT_STICKY
    }

    private fun handleCommand(command: String) {
        when {
            command.equals("REQUEST_FRAME", true) -> lastFrame?.let { liveBridge.sendFrame(it) }
            command.equals("STATUS", true) -> CopilotState.addEvent(this, "LIVE • capture=$captureReady • OCR=$ocrAccepted/$ocrSuccess • кадры=$frames • символов=$lastOcrChars")
            command.equals("STOP", true) -> stopSelf()
            command.startsWith("ATTACHMENT_ANALYSIS|") -> saveAttachmentAnalysis(command)
            command.startsWith("ATTACHMENT_ANALYSIS_ERROR|") -> CopilotState.addEvent(this, "AI • ошибка вложения • " + command.substringAfter('|'))
        }
    }

    private fun saveAttachmentAnalysis(command: String) {
        try {
            val parts = command.split("|", limit = 3)
            if (parts.size < 3) return
            val name = parts[1]
            val json = parts[2]
            CopilotState.saveAttachmentAnalysis(this, name, json)
            val root = org.json.JSONObject(json)
            val vehicle = root.optJSONObject("vehicle")
            val base = CopilotState.snapshot(this)
            val snapshot = VehicleSnapshot(
                vehicle?.optString("name")?.takeIf { it.isNotBlank() } ?: base.name,
                vehicle?.takeIf { it.has("price") }?.optLong("price") ?: base.price,
                vehicle?.takeIf { it.has("hp") }?.optInt("hp") ?: base.hp,
                vehicle?.takeIf { it.has("mileage") }?.optLong("mileage") ?: base.mileage,
                vehicle?.takeIf { it.has("owners") }?.optInt("owners") ?: base.owners,
                vehicle?.optString("plate")?.takeIf { it.isNotBlank() } ?: base.plate,
                vehicle?.optString("origin")?.takeIf { it.isNotBlank() } ?: base.origin,
                vehicle?.takeIf { it.has("paintedParts") }?.optInt("paintedParts") ?: base.paintedParts,
                base.raw
            )
            CopilotState.setSnapshot(this, snapshot)
            CopilotState.addEvent(this, "AI • вложение обработано • $name")
        } catch (e: Exception) {
            CopilotState.addEvent(this, "AI • ошибка структуры вложения • ${e.message}")
        }
    }

    private fun startCapture() {
        if (reader != null || projection == null) return
        val metrics = resources.displayMetrics
        val width = metrics.widthPixels
        val height = metrics.heightPixels
        try {
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3)
            reader?.setOnImageAvailableListener({ source ->
                frames++
                val now = System.currentTimeMillis()
                if (now - lastCapture < 700L) {
                    source.acquireLatestImage()?.close()
                    return@setOnImageAvailableListener
                }
                val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
                lastCapture = now
                processImage(image)
            }, Handler(Looper.getMainLooper()))
            virtualDisplay = projection?.createVirtualDisplay(
                "CarFlipCopilot",
                width,
                height,
                metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader!!.surface,
                null,
                Handler(Looper.getMainLooper())
            )
            if (virtualDisplay == null) {
                lastOcrError = "VirtualDisplay не создан"
                CopilotState.addEvent(this, "CAPTURE • VirtualDisplay=null")
                showOverlayDiagnostics(lastOcrError!!)
                return
            }
            captureReady = true
        } catch (error: Exception) {
            captureReady = false
            lastOcrError = error.message ?: "ошибка создания VirtualDisplay"
            CopilotState.addEvent(this, "CAPTURE • VirtualDisplay error • $lastOcrError")
            showOverlayDiagnostics("CAPTURE ERROR: $lastOcrError")
            reader?.close()
            reader = null
        }
    }

    private fun processImage(image: Image) {
        try {
            val plane = image.planes[0]
            val rowPadding = plane.rowStride - plane.pixelStride * image.width
            val width = image.width + rowPadding / plane.pixelStride
            val bitmap = Bitmap.createBitmap(width, image.height, Bitmap.Config.ARGB_8888)
            bitmap.copyPixelsFromBuffer(plane.buffer)
            image.close()
            val cropped = if (width != image.width) Bitmap.createBitmap(bitmap, 0, 0, image.width, image.height) else bitmap
            if (cropped !== bitmap) bitmap.recycle()
            recognizer.process(InputImage.fromBitmap(cropped, 0))
                .addOnSuccessListener { result ->
                    ocrSuccess++
                    lastOcrAt = System.currentTimeMillis()
                    lastOcrChars = result.text.length
                    lastOcrPreview = result.text.replace(Regex("\\s+"), " ").trim().take(90)
                    if (result.text.isNotBlank()) CopilotState.addEvent(this, "OCR • ${result.text.length} символов • $lastOcrPreview")
                    val text = stableOcr.accept(result.text)
                    if (text == null) {
                        showOverlayDiagnostics("OCR получен • ждём стабильный кадр")
                        try { cropped.recycle() } catch (_: Exception) {}
                        return@addOnSuccessListener
                    }
                    ocrAccepted++
                    updateState(text, cropped)
                }
                .addOnFailureListener { error ->
                    lastOcrError = error.message ?: "неизвестная ошибка OCR"
                    CopilotState.addEvent(this, "OCR • ошибка • $lastOcrError")
                    try { cropped.recycle() } catch (_: Exception) {}
                    showOverlayDiagnostics("OCR ERROR: $lastOcrError")
                }
        } catch (error: Exception) {
            lastOcrError = error.message ?: "ошибка захвата"
            CopilotState.addEvent(this, "CAPTURE • ошибка • $lastOcrError")
            try { image.close() } catch (_: Exception) {}
        }
    }

    private fun updateState(text: String, frame: Bitmap) {
        val vehicle = VehicleSnapshot(
            GameParser.name(text), GameParser.price(text), GameParser.hp(text), GameParser.mileage(text),
            GameParser.owners(text), GameParser.plate(text), GameParser.origin(text), GameParser.paintedParts(text), text
        )
        val balance = GameParser.balance(text) ?: CopilotState.balance(this)
        val garage = GameParser.garage(text) ?: CopilotState.garage(this)
        CopilotState.setBalance(this, balance)
        CopilotState.setGarage(this, garage)
        CopilotState.setSnapshot(this, vehicle)
        val opportunity = DecisionEngine.decide(this, text, vehicle, balance, garage)
        CopilotState.setDecision(this, opportunity.action)
        liveBridge.sendState(text, vehicle, balance, garage, opportunity.action, opportunity)
        val old = lastFrame
        lastFrame = if (frame.width > 720) Bitmap.createScaledBitmap(frame, 720, frame.height * 720 / frame.width, true) else frame.copy(Bitmap.Config.ARGB_8888, false)
        if (old != null && old !== frame) old.recycle()
        CopilotState.addEvent(this, "PARSER • машина='${vehicle.name}' • цена=${vehicle.price} • номер='${vehicle.plate}' • hp=${vehicle.hp} • km=${vehicle.mileage} • окрашено=${vehicle.paintedParts}")
        showOverlayText(opportunity, vehicle)
    }

    private fun showOverlayText(opportunity: Opportunity, vehicle: VehicleSnapshot) {
        overlay?.text = "🚗 COPILOT • LIVE\nOCR: $ocrAccepted/$ocrSuccess • кадры: $frames\nМашина: ${vehicle.name.ifBlank { "—" }}\nНомер: ${vehicle.plate.ifBlank { "—" }} • ${vehicle.hp?.let { "$it л.с." } ?: "—"}\nЦена: ${vehicle.price?.toString() ?: "—"} • OCR: $lastOcrChars симв.\n${opportunity.action} • ${opportunity.confidence}%\n${opportunity.title}"
    }

    private fun showOverlayDiagnostics(message: String) {
        overlay?.text = "🚗 COPILOT • LIVE\n$message\nЗахват: ${if (captureReady) "ГОТОВ" else "НЕТ"}\nКадры: $frames • OCR: $ocrSuccess • принято: $ocrAccepted\nСимволов: $lastOcrChars\n${if (lastOcrPreview.isNotBlank()) lastOcrPreview else "Текст OCR пока отсутствует"}"
    }

    private fun showOverlay() {
        if (!Settings.canDrawOverlays(this)) return
        overlay = TextView(this).apply {
            text = "🚗 COPILOT • LIVE\nПроверка разрешения захвата..."
            setTextColor(Color.WHITE)
            setBackgroundColor(0xAA111111.toInt())
            setPadding(12, 10, 12, 10)
        }
        val manager = getSystemService(WINDOW_SERVICE) as WindowManager
        val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        val params = WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT)
        manager.addView(overlay, params)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(NotificationChannel("copilot", "Copilot", NotificationManager.IMPORTANCE_LOW))
        }
    }

    override fun onDestroy() {
        CopilotState.setMonitoring(this, false)
        try { commandServer.stop() } catch (_: Exception) {}
        try { remotePoller.stop() } catch (_: Exception) {}
        try { liveBridge.stop() } catch (_: Exception) {}
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        projection?.stop()
        reader?.close()
        recognizer.close()
        lastFrame?.recycle()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}