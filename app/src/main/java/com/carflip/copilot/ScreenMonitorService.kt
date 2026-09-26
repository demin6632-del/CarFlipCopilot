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
    private var reader: ImageReader? = null
    private var overlay: TextView? = null
    private var lastFrame: Bitmap? = null
    private var lastCapture = 0L
    private val stableOcr = StableOcr()
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        CopilotState.setMonitoring(this, true)
        createChannel()
        commandServer = CommandServer(this).also { it.start() }
        remotePoller = RemoteCommandPoller(this).also { it.start() }
        liveBridge = LiveBridge(this) { command -> handleCommand(command) }.also { it.start() }
        startForeground(
            10,
            Notification.Builder(this, "copilot")
                .setContentTitle("Перекуп Copilot")
                .setContentText("Realtime мониторинг игры")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .build()
        )
        @Suppress("DEPRECATION")
        val data = intent?.getParcelableExtra<Intent>("data")
        val code = intent?.getIntExtra("resultCode", -1) ?: -1
        if (code != -1 && data != null) {
            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = manager.getMediaProjection(code, data)
            startCapture()
        }
        showOverlay()
        return START_NOT_STICKY
    }

    private fun handleCommand(command: String) {
        when {
            command.equals("REQUEST_FRAME", true) -> lastFrame?.let { liveBridge.sendFrame(it) }
            command.equals("STATUS", true) -> CopilotState.addEvent(this, "LIVE • статус запрошен")
            command.equals("STOP", true) -> stopSelf()
            command.startsWith("ATTACHMENT_ANALYSIS|") -> saveAttachmentAnalysis(command)
            command.startsWith("ATTACHMENT_ANALYSIS_ERROR|") ->
                CopilotState.addEvent(this, "AI • ошибка вложения • " + command.substringAfter('|'))
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
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        projection?.createVirtualDisplay(
            "CarFlipCopilot",
            width,
            height,
            metrics.densityDpi,
            0,
            reader!!.surface,
            null,
            Handler(Looper.getMainLooper())
        )
        reader?.setOnImageAvailableListener({ source ->
            val now = System.currentTimeMillis()
            if (now - lastCapture < 700L) {
                source.acquireLatestImage()?.close()
                return@setOnImageAvailableListener
            }
            val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
            lastCapture = now
            processImage(image)
        }, Handler(Looper.getMainLooper()))
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
                    val text = stableOcr.accept(result.text) ?: return@addOnSuccessListener
                    updateState(text, cropped)
                }
                .addOnFailureListener { image.closeIfNeeded() }
        } catch (_: Exception) {
            try { image.close() } catch (_: Exception) {}
        }
    }

    private fun updateState(text: String, frame: Bitmap) {
        val vehicle = VehicleSnapshot(
            GameParser.name(text),
            GameParser.price(text),
            GameParser.hp(text),
            GameParser.mileage(text),
            GameParser.owners(text),
            GameParser.plate(text),
            GameParser.origin(text),
            GameParser.paintedParts(text),
            text
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
        lastFrame = if (frame.width > 720) {
            Bitmap.createScaledBitmap(frame, 720, frame.height * 720 / frame.width, true)
        } else {
            frame.copy(Bitmap.Config.ARGB_8888, false)
        }
        if (old != null && old !== frame) old.recycle()
        showOverlayText(opportunity)
    }

    private fun showOverlayText(opportunity: Opportunity) {
        overlay?.text = "🚗 COPILOT • LIVE\n${opportunity.action} • ${opportunity.confidence}%\n${opportunity.title}\n${opportunity.reason}"
    }

    private fun showOverlay() {
        if (!Settings.canDrawOverlays(this)) return
        overlay = TextView(this).apply {
            text = "🚗 COPILOT • LIVE"
            setTextColor(Color.WHITE)
            setBackgroundColor(0xAA111111.toInt())
        }
        val manager = getSystemService(WINDOW_SERVICE) as WindowManager
        val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        )
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
        projection?.stop()
        reader?.close()
        recognizer.close()
        lastFrame?.recycle()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun Image.closeIfNeeded() {
        try { close() } catch (_: Exception) {}
    }
}
