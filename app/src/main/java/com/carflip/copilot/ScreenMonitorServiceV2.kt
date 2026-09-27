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
    private var lastOcrPreview = ""
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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannel()
        val notification = Notification.Builder(this, "copilot")
            .setContentTitle("Перекуп Copilot")
            .setContentText("Захват экрана и OCR активны")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(11, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(11, notification)
        }
        showOverlay()

        val code = intent?.getIntExtra("resultCode", Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        val data = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra("data", Intent::class.java)
        } else {
            @Suppress("DEPRECATION") intent?.getParcelableExtra<Intent>("data")
        }
        if (code != Activity.RESULT_OK || data == null) {
            setError("MediaProjection permission not received")
            stopSelf()
            return START_NOT_STICKY
        }

        try {
            val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = mgr.getMediaProjection(code, data)
            if (projection == null) throw IllegalStateException("MediaProjection=null")

            captureThread = HandlerThread("CopilotCaptureV2").also { it.start() }
            captureHandler = Handler(captureThread!!.looper)
            projection!!.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    captureReady = false
                    lastCaptureError = "Android остановил MediaProjection"
                    CopilotState.setMonitoring(this@ScreenMonitorServiceV2, false)
                    releaseDisplayOnly()
                    showDiagnostics(lastCaptureError)
                    CopilotState.addEvent(this@ScreenMonitorServiceV2, "CAPTURE • $lastCaptureError")
                }
            }, captureHandler)

            createCapture()
            CopilotState.setMonitoring(this, captureReady)
            if (captureReady) {
                CopilotState.addEvent(this, "CAPTURE • V2 готов • один VirtualDisplay на одну сессию")
            }
            startWatchdog()
        } catch (e: Exception) {
            setError("CAPTURE ERROR: ${e.javaClass.simpleName}: ${e.message ?: "unknown"}")
            CopilotState.setMonitoring(this, false)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun createCapture() {
        if (projection == null) return
        if (virtualDisplay != null || reader != null) return

        val metrics = resources.displayMetrics
        width = metrics.widthPixels
        height = metrics.heightPixels
        density = metrics.densityDpi
        val h = captureHandler ?: Handler(Looper.getMainLooper())
        try {
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 4)
            reader!!.setOnImageAvailableListener({ source ->
                frames++
                lastFrameAt = SystemClock.elapsedRealtime()
                val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
                if (processing || (lastOcrAt != 0L && SystemClock.elapsedRealtime() - lastOcrAt < 700L)) {
                    image.close()
                    return@setOnImageAvailableListener
                }
                processing = true
                try {
                    processImage(image)
                } catch (e: Exception) {
                    try { image.close() } catch (_: Exception) {}
                    processing = false
                    lastCaptureError = "FRAME ERROR: ${e.message ?: "unknown"}"
                    showDiagnostics(lastCaptureError)
                    CopilotState.addEvent(this, "CAPTURE • $lastCaptureError")
                }
            }, h)

            virtualDisplay = projection?.createVirtualDisplay(
                "CarFlipCopilot-V2",
                width,
                height,
                density,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader!!.surface,
                null,
                h
            )

            if (virtualDisplay == null) {
                lastCaptureError = "VirtualDisplay не создан"
                releaseDisplayOnly()
                captureReady = false
                showDiagnostics(lastCaptureError)
                return
            }

            captureReady = true
            lastCaptureError = ""
            lastFrameAt = SystemClock.elapsedRealtime()
            showDiagnostics("Захват V2 запущен")
        } catch (e: SecurityException) {
            captureReady = false
            lastCaptureError = "Android запретил захват: ${e.message ?: "SecurityException"}"
            releaseDisplayOnly()
            showDiagnostics(lastCaptureError)
            CopilotState.addEvent(this, "CAPTURE • $lastCaptureError")
        } catch (e: Exception) {
            captureReady = false
            lastCaptureError = "VirtualDisplay ERROR: ${e.javaClass.simpleName}: ${e.message ?: "unknown"}"
            releaseDisplayOnly()
            showDiagnostics(lastCaptureError)
            CopilotState.addEvent(this, "CAPTURE • $lastCaptureError")
        }
    }

    private fun processImage(image: Image) {
        var bitmap: Bitmap? = null
        try {
            val imageWidth = image.width
            val imageHeight = image.height
            val plane = image.planes[0]
            val rowPadding = plane.rowStride - plane.pixelStride * imageWidth
            val bitmapWidth = imageWidth + rowPadding / plane.pixelStride

            bitmap = Bitmap.createBitmap(bitmapWidth, imageHeight, Bitmap.Config.ARGB_8888)
            bitmap.copyPixelsFromBuffer(plane.buffer)
            image.close()

            val frame = if (bitmapWidth != imageWidth) {
                Bitmap.createBitmap(bitmap, 0, 0, imageWidth, imageHeight).also { bitmap.recycle() }
            } else {
                bitmap
            }
            bitmap = null

            recognizer.process(InputImage.fromBitmap(frame, 0))
                .addOnSuccessListener { result ->
                    ocrSuccess++
                    lastOcrAt = SystemClock.elapsedRealtime()
                    lastOcrChars = result.text.length
                    lastOcrPreview = result.text.replace(Regex("\\s+"), " ").trim().take(180)
                    val stable = stableOcr.accept(result.text)
                    if (stable != null) {
                        ocrAccepted++
                        updateGameState(stable, frame)
                    } else {
                        showDiagnostics("OCR идёт • ждём следующего изменения экрана")
                        frame.recycleSafely()
                    }
                    processing = false
                }
                .addOnFailureListener { e ->
                    lastOcrAt = SystemClock.elapsedRealtime()
                    lastCaptureError = "OCR ERROR: ${e.message ?: "unknown"}"
                    showDiagnostics(lastCaptureError)
                    frame.recycleSafely()
                    processing = false
                }
        } catch (e: Exception) {
            try { image.close() } catch (_: Exception) {}
            bitmap?.recycleSafely()
            processing = false
            lastCaptureError = "FRAME ERROR: ${e.message ?: "unknown"}"
            showDiagnostics(lastCaptureError)
        }
    }

    private fun updateGameState(text: String, frame: Bitmap) {
        try {
            val screen = GameScreenClassifier.classify(text)
            val event = GameParser.event(text)
            val old = CopilotState.snapshot(this)
            val parsed = VehicleSnapshot(
                GameParser.name(text), GameParser.price(text), GameParser.hp(text),
                GameParser.mileage(text), GameParser.owners(text), GameParser.plate(text),
                GameParser.origin(text), GameParser.paintedParts(text), text
            )
            // Keep the last known car fields when the current screen is a menu, auction,
            // garage or event popup that does not repeat the vehicle details.
            val vehicle = VehicleSnapshot(
                name = parsed.name.ifBlank { old.name },
                price = parsed.price ?: old.price,
                hp = parsed.hp ?: old.hp,
                mileage = parsed.mileage ?: old.mileage,
                owners = parsed.owners ?: old.owners,
                plate = parsed.plate.ifBlank { old.plate },
                origin = parsed.origin.ifBlank { old.origin },
                paintedParts = parsed.paintedParts ?: old.paintedParts,
                raw = text,
                updatedAt = System.currentTimeMillis()
            )

            val balance = GameParser.balance(text) ?: CopilotState.balance(this)
            val garage = GameParser.garage(text) ?: CopilotState.garage(this)
            CopilotState.setBalance(this, balance)
            CopilotState.setGarage(this, garage)
            CopilotState.setSnapshot(this, vehicle)

            if (screen != lastScreen) {
                lastScreen = screen
                CopilotState.addEvent(this, "GAME • экран=$screen • машина='${vehicle.name}'")
            }

            val sale = GameParser.saleAmount(text)
            val purchase = GameParser.purchaseAmount(text)
            val expense = GameParser.expenseAmount(text)
            val reward = GameParser.rewardAmount(text)
            val bid = GameParser.bidAmount(text)
            val plateSale = GameParser.plateSaleEvent(text)
            val eventKey = listOf(event, sale, purchase, expense, reward, bid, plateSale?.plate, plateSale?.payout).joinToString("|")
            if (event != null && eventKey != lastEvent) {
                lastEvent = eventKey
                CopilotState.addEvent(this, "GAME • событие=$event")
                sale?.let { CopilotState.addEvent(this, "GAME • продажа=$it ₽") }
                purchase?.let { CopilotState.addEvent(this, "GAME • покупка=$it ₽") }
                expense?.let { CopilotState.addEvent(this, "GAME • расход=$it ₽") }
                reward?.let { CopilotState.addEvent(this, "GAME • награда=$it ₽") }
                bid?.let { CopilotState.addEvent(this, "GAME • ставка/предложение=$it ₽") }
                plateSale?.let {
                    CopilotState.addEvent(this, "GAME • номер ${it.plate} продан • выплата=${it.payout} ₽ • комиссия=${it.commission} ₽")
                }
            }

            GameParser.contract(text)?.let { contract ->
                if (!lastEvent.contains(contract)) CopilotState.addEvent(this, "GAME • задание=$contract")
            }
            GameParser.action(text)?.let { CopilotState.addEvent(this, "GAME • действие=$it") }

            val resources = GameParser.resources(text)
            if (resources.isNotEmpty()) {
                CopilotState.addEvent(this, "GAME • ресурсы=" + resources.entries.joinToString(", ") { "${it.key}:${it.value}" })
            }

            val opportunity = DecisionEngine.decide(this, text, vehicle, balance, garage)
            CopilotState.setDecision(this, opportunity.action)
            val forecast = CopilotState.dealForecast(this, vehicle)
            CopilotState.saveForecast(
                this,
                forecast.optLong("sale_price").takeIf { it > 0 },
                if (forecast.has("expected_profit") && !forecast.isNull("expected_profit")) forecast.optLong("expected_profit") else null,
                if (forecast.has("roi_percent") && !forecast.isNull("roi_percent")) forecast.optDouble("roi_percent") else null,
                opportunity.confidence
            )

            val oldFrame = lastFrame
            lastFrame = if (frame.width > 720) {
                Bitmap.createScaledBitmap(frame, 720, frame.height * 720 / frame.width, true)
            } else frame.copy(Bitmap.Config.ARGB_8888, false)
            oldFrame?.recycleSafely()
            showLive(opportunity, vehicle, screen)
            frame.recycleSafely()
        } catch (e: Exception) {
            frame.recycleSafely()
            CopilotState.addEvent(this, "GAME • parser error • ${e.message}")
        }
    }

    private fun startWatchdog() {
        val h = captureHandler ?: return
        watchdog = object : Runnable {
            override fun run() {
                val age = if (lastFrameAt == 0L) Long.MAX_VALUE else SystemClock.elapsedRealtime() - lastFrameAt
                if (captureReady && age > 4000L) {
                    lastCaptureError = "Кадры не поступают ${age}мс. Нажми «Запустить мониторинг» заново для новой сессии Android."
                    captureReady = false
                    CopilotState.setMonitoring(this@ScreenMonitorServiceV2, false)
                    showDiagnostics(lastCaptureError)
                    CopilotState.addEvent(this@ScreenMonitorServiceV2, "CAPTURE • $lastCaptureError")
                } else {
                    showDiagnostics(if (captureReady) "Захват V2 работает" else (lastCaptureError.ifBlank { "Захват V2 остановлен" }))
                }
                h.postDelayed(this, 2000L)
            }
        }
        h.postDelayed(watchdog!!, 2000L)
    }

    private fun showLive(opportunity: Opportunity, vehicle: VehicleSnapshot, screen: String) {
        overlay?.post {
            overlay?.text = "🚗 COPILOT • LIVE V2\nЗахват: ${if (captureReady) "ГОТОВ" else "НЕТ"}\nКадры: $frames • OCR: $ocrAccepted/$ocrSuccess • символов: $lastOcrChars\nРаздел: ${screen.ifBlank { "—" }}\nМашина: ${vehicle.name.ifBlank { "—" }}\nНомер: ${vehicle.plate.ifBlank { "—" }}\nРешение: ${opportunity.action} • ${opportunity.confidence}%\nOCR: ${lastOcrPreview.take(90)}"
        }
    }

    private fun showDiagnostics(message: String) {
        overlay?.post {
            overlay?.text = "🚗 COPILOT • LIVE V2\n$message\nЗахват: ${if (captureReady) "ГОТОВ" else "НЕТ"}\nКадры: $frames • OCR: $ocrSuccess • принято: $ocrAccepted\nСимволов: $lastOcrChars\nРаздел: ${lastScreen.ifBlank { "—" }}\n${lastOcrPreview.ifBlank { "Текст OCR пока отсутствует" }}"
        }
    }

    private fun setError(message: String) {
        lastCaptureError = message
        CopilotState.addEvent(this, "CAPTURE • $message")
        showDiagnostics(message)
    }

    private fun showOverlay() {
        if (!Settings.canDrawOverlays(this)) return
        overlay = TextView(this).apply {
            setTextColor(Color.WHITE)
            setBackgroundColor(0xAA111111.toInt())
            setPadding(12, 10, 12, 10)
            text = "🚗 COPILOT • LIVE V2\nПроверка захвата..."
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

    private fun releaseDisplayOnly() {
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { reader?.close() } catch (_: Exception) {}
        reader = null
        captureReady = false
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(NotificationChannel("copilot", "Copilot", NotificationManager.IMPORTANCE_LOW))
        }
    }

    override fun onDestroy() {
        CopilotState.setMonitoring(this, false)
        watchdog?.let { captureHandler?.removeCallbacks(it) }
        try { virtualDisplay?.release() } catch (_: Exception) {}
        try { reader?.close() } catch (_: Exception) {}
        try { projection?.stop() } catch (_: Exception) {}
        lastFrame?.recycleSafely()
        try { captureThread?.quitSafely() } catch (_: Exception) {}
        overlay?.let { v -> try { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(v) } catch (_: Exception) {} }
        super.onDestroy()
    }

    private fun Bitmap.recycleSafely() { if (!isRecycled) recycle() }
}
