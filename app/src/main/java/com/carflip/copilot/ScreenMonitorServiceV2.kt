package com.carflip.copilot

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.*
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.provider.Settings
import android.text.TextUtils
import android.view.*
import android.widget.TextView
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

class ScreenMonitorServiceV2 : Service() {
    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null
    private var watchdog: Runnable? = null
    private var overlay: TextView? = null
    private var lastFrame: Bitmap? = null
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
    private val stableOcr = StableOcr()
    private var frames = 0
    private var ocrSuccess = 0
    private var ocrAccepted = 0
    private var lastOcrChars = 0
    private var lastOcrAt = 0L
    private var lastFrameAt = 0L
    private var lastScreen = ""
    private var lastEvent = ""
    private var lastCaptureError = ""
    private var captureReady = false
    private var processing = false
    private var width = 0
    private var height = 0
    private var density = 0
    private var liveAction = "АНАЛИЗИРУЮ"
    private var liveConfidence = 0
    private var liveVehicle = "—"
    private var livePlate = "—"
    private var liveScreen = "—"
    private var liveStatus = "Запуск..."
    private var lastOverlayText = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannel()
        val notification = Notification.Builder(this, "copilot")
            .setContentTitle("Перекуп Copilot")
            .setContentText("Захват экрана и OCR активны")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(11, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(11, notification)
        showOverlay()

        val code = intent?.getIntExtra("resultCode", Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        val data = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra("data", Intent::class.java)
        else @Suppress("DEPRECATION") intent?.getParcelableExtra<Intent>("data")
        if (code != Activity.RESULT_OK || data == null) {
            setError("Нет разрешения на захват экрана")
            stopSelf(); return START_NOT_STICKY
        }
        try {
            val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = mgr.getMediaProjection(code, data) ?: throw IllegalStateException("MediaProjection=null")
            captureThread = HandlerThread("CopilotCaptureV2").also { it.start() }
            captureHandler = Handler(captureThread!!.looper)
            projection!!.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    captureReady = false
                    setStatus("Захват остановлен Android")
                    CopilotState.setMonitoring(this@ScreenMonitorServiceV2, false)
                    releaseDisplayOnly()
                }
            }, captureHandler)
            createCapture()
            CopilotState.setMonitoring(this, captureReady)
            if (captureReady) CopilotState.addEvent(this, "CAPTURE • V2 готов")
            startWatchdog()
        } catch (e: Exception) {
            setError("Ошибка захвата: ${e.message ?: e.javaClass.simpleName}")
            CopilotState.setMonitoring(this, false); stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun createCapture() {
        if (projection == null || virtualDisplay != null || reader != null) return
        val metrics = resources.displayMetrics
        width = metrics.widthPixels; height = metrics.heightPixels; density = metrics.densityDpi
        val h = captureHandler ?: Handler(Looper.getMainLooper())
        try {
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 4)
            reader!!.setOnImageAvailableListener({ source ->
                frames++; lastFrameAt = SystemClock.elapsedRealtime()
                val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
                if (processing || (lastOcrAt != 0L && SystemClock.elapsedRealtime() - lastOcrAt < 700L)) { image.close(); return@setOnImageAvailableListener }
                processing = true
                try { processImage(image) } catch (e: Exception) {
                    try { image.close() } catch (_: Exception) {}
                    processing = false; setStatus("Ошибка кадра: ${e.message ?: "unknown"}")
                }
            }, h)
            virtualDisplay = projection!!.createVirtualDisplay("CarFlipCopilot-V2", width, height, density,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader!!.surface, null, h)
            if (virtualDisplay == null) { setError("VirtualDisplay не создан"); releaseDisplayOnly(); return }
            captureReady = true; lastCaptureError = ""; lastFrameAt = SystemClock.elapsedRealtime(); setStatus("Захват работает")
        } catch (e: Exception) {
            captureReady = false; lastCaptureError = "Ошибка VirtualDisplay: ${e.message ?: e.javaClass.simpleName}"; releaseDisplayOnly(); setStatus(lastCaptureError)
        }
    }

    private fun processImage(image: Image) {
        var bitmap: Bitmap? = null
        try {
            val w = image.width; val h = image.height; val plane = image.planes[0]
            val rowPadding = plane.rowStride - plane.pixelStride * w
            val bitmapWidth = w + rowPadding / plane.pixelStride
            bitmap = Bitmap.createBitmap(bitmapWidth, h, Bitmap.Config.ARGB_8888)
            bitmap.copyPixelsFromBuffer(plane.buffer); image.close()
            val frame = if (bitmapWidth != w) Bitmap.createBitmap(bitmap, 0, 0, w, h).also { bitmap.recycle() } else bitmap
            bitmap = null
            recognizer.process(InputImage.fromBitmap(frame, 0)).addOnSuccessListener { result ->
                ocrSuccess++; lastOcrAt = SystemClock.elapsedRealtime(); lastOcrChars = result.text.length
                val stable = stableOcr.accept(result.text)
                if (stable != null) { ocrAccepted++; updateGameState(stable, frame) } else frame.recycleSafely()
                processing = false
            }.addOnFailureListener { e ->
                lastOcrAt = SystemClock.elapsedRealtime(); setStatus("OCR: ${e.message ?: "ошибка"}"); frame.recycleSafely(); processing = false
            }
        } catch (e: Exception) {
            try { image.close() } catch (_: Exception) {}; bitmap?.recycleSafely(); processing = false; setStatus("Кадр: ${e.message ?: "ошибка"}")
        }
    }

    private fun updateGameState(text: String, frame: Bitmap) {
        try {
            val screen = GameScreenClassifier.classify(text)
            val event = GameParser.event(text)
            val old = CopilotState.snapshot(this)
            val parsed = VehicleSnapshot(GameParser.name(text), GameParser.price(text), GameParser.hp(text), GameParser.mileage(text), GameParser.owners(text), GameParser.plate(text), GameParser.origin(text), GameParser.paintedParts(text), text)
            val vehicle = VehicleSnapshot(parsed.name.ifBlank { old.name }, parsed.price ?: old.price, parsed.hp ?: old.hp, parsed.mileage ?: old.mileage, parsed.owners ?: old.owners, parsed.plate.ifBlank { old.plate }, parsed.origin.ifBlank { old.origin }, parsed.paintedParts ?: old.paintedParts, text, System.currentTimeMillis())
            val balance = GameParser.balance(text) ?: CopilotState.balance(this)
            val garage = GameParser.garage(text) ?: CopilotState.garage(this)
            CopilotState.setBalance(this, balance); CopilotState.setGarage(this, garage); CopilotState.setSnapshot(this, vehicle)
            if (screen != lastScreen) { lastScreen = screen; CopilotState.addEvent(this, "GAME • экран=$screen") }
            val sale = GameParser.saleAmount(text); val purchase = GameParser.purchaseAmount(text); val expense = GameParser.expenseAmount(text); val reward = GameParser.rewardAmount(text); val bid = GameParser.bidAmount(text); val plateSale = GameParser.plateSaleEvent(text)
            val eventKey = listOf(event, sale, purchase, expense, reward, bid, plateSale?.plate, plateSale?.payout).joinToString("|")
            if (event != null && eventKey != lastEvent) {
                lastEvent = eventKey; CopilotState.addEvent(this, "GAME • событие=$event")
                sale?.let { CopilotState.addEvent(this, "GAME • продажа=$it ₽") }; purchase?.let { CopilotState.addEvent(this, "GAME • покупка=$it ₽") }; expense?.let { CopilotState.addEvent(this, "GAME • расход=$it ₽") }; reward?.let { CopilotState.addEvent(this, "GAME • награда=$it ₽") }; bid?.let { CopilotState.addEvent(this, "GAME • ставка=$it ₽") }
                plateSale?.let { CopilotState.addEvent(this, "GAME • номер ${it.plate} • выплата=${it.payout} ₽") }
            }
            GameParser.contract(text)?.let { CopilotState.addEvent(this, "GAME • задание=$it") }
            GameParser.action(text)?.let { CopilotState.addEvent(this, "GAME • действие=$it") }
            GameParser.resources(text).takeIf { it.isNotEmpty() }?.let { CopilotState.addEvent(this, "GAME • ресурсы=" + it.entries.joinToString(", ") { e -> "${e.key}:${e.value}" }) }
            val opportunity = DecisionEngine.decide(this, text, vehicle, balance, garage)
            CopilotState.setDecision(this, opportunity.action)
            val forecast = CopilotState.dealForecast(this, vehicle)
            CopilotState.saveForecast(this, forecast.optLong("sale_price").takeIf { it > 0 }, forecast.optLong("expected_profit").takeIf { forecast.has("expected_profit") && !forecast.isNull("expected_profit") }, forecast.optDouble("roi_percent").takeIf { forecast.has("roi_percent") && !forecast.isNull("roi_percent") }, opportunity.confidence)
            val oldFrame = lastFrame; lastFrame = if (frame.width > 720) Bitmap.createScaledBitmap(frame, 720, frame.height * 720 / frame.width, true) else frame.copy(Bitmap.Config.ARGB_8888, false); oldFrame?.recycleSafely()
            liveAction = opportunity.action; liveConfidence = opportunity.confidence; liveVehicle = vehicle.name.ifBlank { "—" }; livePlate = vehicle.plate.ifBlank { "—" }; liveScreen = screen.ifBlank { "—" }; setStatus("Анализ обновлён")
            renderOverlay(); frame.recycleSafely()
        } catch (e: Exception) { frame.recycleSafely(); setStatus("Ошибка анализа: ${e.message ?: "unknown"}") }
    }

    private fun startWatchdog() {
        val h = captureHandler ?: return
        watchdog = object : Runnable { override fun run() {
            val age = if (lastFrameAt == 0L) Long.MAX_VALUE else SystemClock.elapsedRealtime() - lastFrameAt
            if (captureReady && age > 4000L) { captureReady = false; CopilotState.setMonitoring(this@ScreenMonitorServiceV2, false); setStatus("Кадры остановились — запусти мониторинг заново") }
            else if (captureReady) setStatus("Мониторинг работает")
            h.postDelayed(this, 3000L)
        }}
        h.postDelayed(watchdog!!, 3000L)
    }

    private fun setStatus(message: String) { lastCaptureError = if (message.startsWith("Ошибка") || message.contains("останов")) message else ""; liveStatus = message; renderOverlay() }

    private fun renderOverlay() {
        val view = overlay ?: return
        view.post {
            val text = "COPILOT  •  LIVE\n" +
                "━━━━━━━━━━━━━━━━━━━━\n" +
                "СЕЙЧАС: $liveAction${if (liveConfidence > 0) "  •  $liveConfidence%" else ""}\n" +
                "Машина: $liveVehicle\n" +
                "Номер: $livePlate\n" +
                "Раздел: $liveScreen\n" +
                "━━━━━━━━━━━━━━━━━━━━\n" +
                "Статус: $liveStatus\n" +
                "Захват: ${if (captureReady) "ГОТОВ" else "НЕТ"}  •  OCR: $ocrAccepted\n" +
                "Кадры: $frames"
            if (text != lastOverlayText) { lastOverlayText = text; view.text = text }
        }
    }

    private fun showOverlay() {
        if (!Settings.canDrawOverlays(this)) return
        overlay = TextView(this).apply {
            setTextColor(Color.WHITE); setBackgroundColor(0xE6111111.toInt()); setPadding(18, 16, 18, 16)
            textSize = 14f; typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL); gravity = Gravity.START
            maxLines = 12; ellipsize = TextUtils.TruncateAt.END; includeFontPadding = true
        }
        val manager = getSystemService(WINDOW_SERVICE) as WindowManager
        val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        val widthPx = (300 * resources.displayMetrics.density).toInt()
        val params = WindowManager.LayoutParams(widthPx, WindowManager.LayoutParams.WRAP_CONTENT, type, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS, PixelFormat.TRANSLUCENT)
        params.gravity = Gravity.TOP or Gravity.START; params.x = 12; params.y = 80
        manager.addView(overlay, params); renderOverlay()
    }

    private fun releaseDisplayOnly() { try { virtualDisplay?.release() } catch (_: Exception) {}; virtualDisplay = null; try { reader?.close() } catch (_: Exception) {}; reader = null; captureReady = false }
    private fun createChannel() { if (Build.VERSION.SDK_INT >= 26) (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(NotificationChannel("copilot", "Copilot", NotificationManager.IMPORTANCE_LOW)) }
    private fun setError(message: String) { liveStatus = message; CopilotState.addEvent(this, "CAPTURE • $message"); renderOverlay() }
    override fun onDestroy() { CopilotState.setMonitoring(this, false); watchdog?.let { captureHandler?.removeCallbacks(it) }; try { virtualDisplay?.release() } catch (_: Exception) {}; try { reader?.close() } catch (_: Exception) {}; try { projection?.stop() } catch (_: Exception) {}; lastFrame?.recycleSafely(); try { captureThread?.quitSafely() } catch (_: Exception) {}; overlay?.let { try { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it) } catch (_: Exception) {} }; super.onDestroy() }
    private fun Bitmap.recycleSafely() { if (!isRecycled) recycle() }
}
