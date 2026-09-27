package com.carflip.copilot

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.*
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
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
    private var lastScreenType = ""
    private var lastGameEvent = ""
    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        CopilotState.setMonitoring(this, false)
        createChannel()
        commandServer = CommandServer(this).also { it.start() }
        remotePoller = RemoteCommandPoller(this).also { it.start() }
        liveBridge = LiveBridge(this) { command -> handleCommand(command) }.also { it.start() }
        val notification = Notification.Builder(this, "copilot")
            .setContentTitle("Перекуп Copilot")
            .setContentText("Захват экрана и OCR активны")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(10, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) else startForeground(10, notification)
        showOverlay()
        val code = intent?.getIntExtra("resultCode", Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        val data = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra("data", Intent::class.java) else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra<Intent>("data")
        }
        if (code != Activity.RESULT_OK || data == null) {
            lastOcrError = "Разрешение MediaProjection не получено"
            showOverlayDiagnostics(lastOcrError)
            CopilotState.addEvent(this, "CAPTURE • разрешение захвата не получено")
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = manager.getMediaProjection(code, data)
            if (projection == null) {
                lastOcrError = "MediaProjection вернул null"
                showOverlayDiagnostics(lastOcrError)
                CopilotState.addEvent(this, "CAPTURE • MediaProjection=null")
                stopSelf()
                return START_NOT_STICKY
            }
            captureThread = HandlerThread("CopilotCapture").also { it.start() }
            captureHandler = Handler(captureThread!!.looper)
            projection?.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    captureReady = false
                    CopilotState.setMonitoring(this@ScreenMonitorService, false)
                    lastOcrError = "Захват экрана остановлен Android"
                    CopilotState.addEvent(this@ScreenMonitorService, "CAPTURE • MediaProjection остановлен")
                    showOverlayDiagnostics(lastOcrError)
                }
            }, captureHandler)
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
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun handleCommand(command: String) {
        when {
            command.equals("REQUEST_FRAME", true) -> lastFrame?.let { liveBridge.sendFrame(it) }
            command.equals("STATUS", true) -> CopilotState.addEvent(this, "LIVE • capture=$captureReady • OCR=$ocrAccepted/$ocrSuccess • кадры=$frames • символов=$lastOcrChars • экран=$lastScreenType")
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
            val snapshot = VehicleSnapshot(vehicle?.optString("name")?.takeIf { it.isNotBlank() } ?: base.name, vehicle?.takeIf { it.has("price") }?.optLong("price") ?: base.price, vehicle?.takeIf { it.has("hp") }?.optInt("hp") ?: base.hp, vehicle?.takeIf { it.has("mileage") }?.optLong("mileage") ?: base.mileage, vehicle?.takeIf { it.has("owners") }?.optInt("owners") ?: base.owners, vehicle?.optString("plate")?.takeIf { it.isNotBlank() } ?: base.plate, vehicle?.optString("origin")?.takeIf { it.isNotBlank() } ?: base.origin, vehicle?.takeIf { it.has("paintedParts") }?.optInt("paintedParts") ?: base.paintedParts, base.raw)
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
            val callbackHandler = captureHandler ?: Handler(Looper.getMainLooper())
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
            reader?.setOnImageAvailableListener({ source ->
                frames++
                val now = System.currentTimeMillis()
                val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
                if (now - lastCapture < 700L) {
                    image.close()
                    return@setOnImageAvailableListener
                }
                lastCapture = now
                processImage(image)
            }, callbackHandler)
            virtualDisplay = projection?.createVirtualDisplay("CarFlipCopilot", width, height, metrics.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader!!.surface, null, callbackHandler)
            if (virtualDisplay == null) {
                lastOcrError = "VirtualDisplay не создан"
                CopilotState.addEvent(this, "CAPTURE • VirtualDisplay=null")
                showOverlayDiagnostics(lastOcrError)
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
        var bitmap: Bitmap? = null
        try {
            val plane = image.planes[0]
            val rowPadding = plane.rowStride - plane.pixelStride * image.width
            val width = image.width + rowPadding / plane.pixelStride
            bitmap = Bitmap.createBitmap(width, image.height, Bitmap.Config.ARGB_8888)
            bitmap.copyPixelsFromBuffer(plane.buffer)
            image.close()
            val cropped = if (width != image.width) Bitmap.createBitmap(bitmap, 0, 0, image.width, image.height) else bitmap
            if (cropped !== bitmap) bitmap.recycle()
            recognizer.process(InputImage.fromBitmap(cropped, 0)).addOnSuccessListener { result ->
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
            }.addOnFailureListener { error ->
                lastOcrError = error.message ?: "неизвестная ошибка OCR"
                CopilotState.addEvent(this, "OCR • ошибка • $lastOcrError")
                try { cropped.recycle() } catch (_: Exception) {}
                showOverlayDiagnostics("OCR ERROR: $lastOcrError")
            }
        } catch (error: Exception) {
            lastOcrError = error.message ?: "ошибка захвата"
            CopilotState.addEvent(this, "CAPTURE • ошибка • $lastOcrError")
            try { image.close() } catch (_: Exception) {}
            try { bitmap?.recycle() } catch (_: Exception) {}
        }
    }

    private fun updateState(text: String, frame: Bitmap) {
        val screen = GameScreenClassifier.classify(text)
        val event = GameParser.event(text)
        val action = GameParser.action(text)
        val contract = GameParser.contract(text)
        val reward = GameParser.rewardAmount(text)
        val resources = GameParser.resources(text)
        val vehicle = VehicleSnapshot(GameParser.name(text), GameParser.price(text), GameParser.hp(text), GameParser.mileage(text), GameParser.owners(text), GameParser.plate(text), GameParser.origin(text), GameParser.paintedParts(text), text)
        val balance = GameParser.balance(text) ?: CopilotState.balance(this)
        val garage = GameParser.garage(text) ?: CopilotState.garage(this)
        CopilotState.setBalance(this, balance)
        CopilotState.setGarage(this, garage)
        CopilotState.setSnapshot(this, vehicle)
        if (screen != lastScreenType) {
            lastScreenType = screen
            CopilotState.addEvent(this, "GAME • экран=$screen • навигация=${GameScreenClassifier.isNavigationSection(screen)} • машина='${vehicle.name}' • баланс=$balance")
        }
        if (event != null && event != lastGameEvent) {
            lastGameEvent = event
            CopilotState.addEvent(this, "GAME • событие=$event")
        }
        if (action != null) CopilotState.addEvent(this, "GAME • действие=$action")
        if (contract != null) CopilotState.addEvent(this, "GAME • задание=${contract.take(240)}")
        if (reward != null) CopilotState.addEvent(this, "GAME • награда=$reward")
        if (resources.isNotEmpty()) CopilotState.addEvent(this, "GAME • ресурсы=" + resources.entries.joinToString(", ") { "${it.key}=${it.value}" })
        val opportunity = DecisionEngine.decide(this, text, vehicle, balance, garage)
        CopilotState.setDecision(this, opportunity.action)
        liveBridge.sendState(text, vehicle, balance, garage, opportunity.action, opportunity)
        val old = lastFrame
        lastFrame = if (frame.width > 720) Bitmap.createScaledBitmap(frame, 720, frame.height * 720 / frame.width, true) else frame.copy(Bitmap.Config.ARGB_8888, false)
        if (old != null && old !== frame) old.recycle()
        CopilotState.addEvent(this, "PARSER • экран=$screen • машина='${vehicle.name}' • цена=${vehicle.price} • номер='${vehicle.plate}' • hp=${vehicle.hp} • km=${vehicle.mileage} • окрашено=${vehicle.paintedParts}")
        showOverlayText(opportunity, vehicle, screen)
        if (frame !== lastFrame) {
            try { frame.recycle() } catch (_: Exception) {}
        }
    }

    private fun showOverlayText(opportunity: Opportunity, vehicle: VehicleSnapshot, screen: String) {
        overlay?.post {
            overlay?.text = "🚗 COPILOT • LIVE\nРаздел: $screen • OCR: $ocrAccepted/$ocrSuccess • кадры: $frames\nМашина: ${vehicle.name.ifBlank { "—" }}\nНомер: ${vehicle.plate.ifBlank { "—" }} • ${vehicle.hp?.let { "$it л.с." } ?: "—"}\nЦена/вложено: ${vehicle.price?.toString() ?: "—"} • OCR: $lastOcrChars симв.\n${opportunity.action} • ${opportunity.confidence}%\n${opportunity.title}"
        }
    }

    private fun showOverlayDiagnostics(message: String) {
        overlay?.post {
            overlay?.text = "🚗 COPILOT • LIVE\n$message\nЗахват: ${if (captureReady) "ГОТОВ" else "НЕТ"}\nКадры: $frames • OCR: $ocrSuccess • принято: $ocrAccepted\nСимволов: $lastOcrChars\nРаздел: ${if (lastScreenType.isBlank()) "—" else lastScreenType}\n${if (lastOcrPreview.isNotBlank()) lastOcrPreview else "Текст OCR пока отсутствует"}"
        }
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
        try { projection?.stop() } catch (_: Exception) {}
        projection = null
        reader?.close()
        reader = null
        try { captureThread?.quitSafely() } catch (_: Exception) {}
        captureThread = null
        captureHandler = null
        recognizer.close()
        lastFrame?.recycle()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
