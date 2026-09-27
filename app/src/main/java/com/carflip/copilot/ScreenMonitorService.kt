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
import org.json.JSONObject

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
    @Volatile private var processingOcr = false
    private var frames = 0
    private var ocrSuccess = 0
    private var ocrAccepted = 0
    private var lastOcrChars = 0
    private var lastOcrError = ""
    private var captureReady = false
    private var captureStopping = false
    private var lastScreenType = ""
    private var lastGameEvent = ""
    private var lastNewsSummary = ""
    private var lastPromoCode = ""
    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null
    private var decisionHandler: Handler? = null
    private var lastOpportunity: Opportunity? = null
    private var lastVehicle = VehicleSnapshot("", null, null, null, null, "", "", null, "")
    private var lastAiStatus = "Жду анализа ChatGPT…"

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        CopilotState.setMonitoring(this, false); createChannel()
        commandServer = CommandServer(this).also { it.start() }
        remotePoller = RemoteCommandPoller(this).also { it.start() }
        liveBridge = LiveBridge(this) { command -> handleCommand(command) }.also { it.start() }
        val notification = Notification.Builder(this, "copilot").setContentTitle("Перекуп Copilot").setContentText("Захват экрана и OCR активны").setSmallIcon(android.R.drawable.ic_menu_view).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(10, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) else startForeground(10, notification)
        showOverlay()
        val code = intent?.getIntExtra("resultCode", Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        val data = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra("data", Intent::class.java) else { @Suppress("DEPRECATION") intent?.getParcelableExtra<Intent>("data") }
        if (code != Activity.RESULT_OK || data == null) { lastOcrError = "Разрешение MediaProjection не получено"; showStatusPreservingDecision(lastOcrError); stopSelf(); return START_NOT_STICKY }
        try {
            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = manager.getMediaProjection(code, data)
            if (projection == null) { lastOcrError = "MediaProjection вернул null"; showStatusPreservingDecision(lastOcrError); stopSelf(); return START_NOT_STICKY }
            captureThread = HandlerThread("CopilotCapture").also { it.start() }; captureHandler = Handler(captureThread!!.looper); decisionHandler = Handler(captureThread!!.looper)
            projection?.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    captureReady = false
                    captureStopping = true
                    CopilotState.setMonitoring(this@ScreenMonitorService, false)
                    lastOcrError = "Android остановил захват. Нажми «Запустить мониторинг» и выдай разрешение ещё раз."
                    CopilotState.addEvent(this@ScreenMonitorService, "CAPTURE • MediaProjection остановлен Android")
                    releaseCaptureOnly()
                    showStatusPreservingDecision(lastOcrError)
                }
            }, captureHandler)
            startCapture()
            if (captureReady) { CopilotState.setMonitoring(this, true); CopilotState.addEvent(this, "CAPTURE • MediaProjection готов • OCR запущен"); showStatusPreservingDecision("Захват экрана запущен") }
        } catch (error: Exception) { lastOcrError = error.message ?: "ошибка запуска MediaProjection"; CopilotState.setMonitoring(this, false); CopilotState.addEvent(this, "CAPTURE • ошибка запуска • $lastOcrError"); showStatusPreservingDecision(lastOcrError); stopSelf() }
        return START_NOT_STICKY
    }

    private fun handleCommand(command: String) {
        when {
            command.equals("REQUEST_FRAME", true) -> lastFrame?.let { liveBridge.sendFrame(it) }
            command.equals("STATUS", true) -> CopilotState.addEvent(this, "LIVE • capture=" + captureReady + " • OCR=" + ocrSuccess + " • кадры=" + frames + " • символов=" + lastOcrChars + " • экран=" + lastScreenType + " • AI=" + lastAiStatus)
            command.equals("STOP", true) -> stopSelf()
            command.startsWith("AI_STATUS|") -> { lastAiStatus = command.substringAfter("|"); showStatusPreservingDecision(lastAiStatus) }
            command.startsWith("AI_DECISION|") -> applyAiDecision(command.substringAfter("|"))
            command.startsWith("ATTACHMENT_ANALYSIS|") -> saveAttachmentAnalysis(command)
            command.startsWith("ATTACHMENT_ANALYSIS_ERROR|") -> CopilotState.addEvent(this, "AI • ошибка вложения • " + command.substringAfter("|"))
        }
    }

    private fun applyAiDecision(json: String) {
        try {
            val o = JSONObject(json)
            val opportunity = Opportunity(o.optString("action", "ОЖИДАЙ"), o.optString("title", "ChatGPT анализирует ситуацию"), o.optString("reason", "Жду следующего подтверждённого состояния игры."), o.optInt("confidence", 0).coerceIn(0, 100))
            lastOpportunity = opportunity
            lastAiStatus = "Решение получено от ChatGPT"
            CopilotState.setDecision(this, opportunity.action)
            val sale = if (o.isNull("sale_price")) null else o.optLong("sale_price").takeIf { it > 0L }
            val profit = if (o.isNull("expected_profit")) null else o.optLong("expected_profit")
            val roi = if (o.isNull("roi_percent")) null else o.optDouble("roi_percent")
            CopilotState.saveForecast(this, sale, profit, roi, opportunity.confidence)
            CopilotState.addEvent(this, "AI • ChatGPT: " + opportunity.action + " • " + opportunity.title)
            showOverlayDecision(opportunity, lastVehicle, lastScreenType)
        } catch (e: Exception) {
            lastAiStatus = "Ошибка ответа ChatGPT"
            CopilotState.addEvent(this, "AI • ошибка решения • " + (e.message ?: "неизвестная ошибка"))
            showStatusPreservingDecision(lastAiStatus)
        }
    }

    private fun saveAttachmentAnalysis(command: String) { try { val parts = command.split("|", limit = 3); if (parts.size < 3) return; val name = parts[1]; val json = parts[2]; CopilotState.saveAttachmentAnalysis(this, name, json); CopilotState.addEvent(this, "AI • вложение обработано • $name") } catch (e: Exception) { CopilotState.addEvent(this, "AI • ошибка структуры вложения • ${e.message}") } }

    private fun startCapture() {
        if (reader != null || projection == null) return
        val metrics = resources.displayMetrics
        val sourceWidth = metrics.widthPixels
        val sourceHeight = metrics.heightPixels
        val width = minOf(sourceWidth, 900)
        val height = (sourceHeight.toLong() * width / sourceWidth).toInt().coerceAtLeast(1)
        try {
            val callbackHandler = captureHandler ?: Handler(Looper.getMainLooper())
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3)
            reader?.setOnImageAvailableListener({ source ->
                frames++; val now = System.currentTimeMillis(); val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
                if (now - lastCapture < 650L || processingOcr) { image.close(); return@setOnImageAvailableListener }
                lastCapture = now; processingOcr = true; processImage(image)
            }, callbackHandler)
            virtualDisplay = projection?.createVirtualDisplay("CarFlipCopilot", width, height, metrics.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader!!.surface, null, callbackHandler)
            if (virtualDisplay == null) { lastOcrError = "VirtualDisplay не создан"; CopilotState.addEvent(this, "CAPTURE • VirtualDisplay=null"); showStatusPreservingDecision(lastOcrError); return }
            captureReady = true
        } catch (error: Exception) { captureReady = false; lastOcrError = error.message ?: "ошибка создания VirtualDisplay"; CopilotState.addEvent(this, "CAPTURE • VirtualDisplay error • $lastOcrError"); showStatusPreservingDecision(lastOcrError); reader?.close(); reader = null }
    }

    private fun processImage(image: Image) {
        try {
            val plane = image.planes[0]; val rowPadding = plane.rowStride - plane.pixelStride * image.width; val width = image.width + rowPadding / plane.pixelStride
            val bitmap = Bitmap.createBitmap(width, image.height, Bitmap.Config.ARGB_8888); bitmap.copyPixelsFromBuffer(plane.buffer); image.close()
            val cropped = if (width != image.width) Bitmap.createBitmap(bitmap, 0, 0, image.width, image.height) else bitmap
            if (cropped !== bitmap) bitmap.recycle()
            recognizer.process(InputImage.fromBitmap(cropped, 0)).addOnSuccessListener { result ->
                try {
                    ocrSuccess++; lastOcrChars = result.text.length; val text = stableOcr.accept(result.text)
                    if (text != null) decisionHandler?.post { try { updateState(text, cropped) } finally { processingOcr = false } } else { showStatusPreservingDecision("Обновление данных…"); processingOcr = false }
                } catch (_: Exception) { processingOcr = false }
            }.addOnFailureListener { error -> lastOcrError = error.message ?: "ошибка OCR"; CopilotState.addEvent(this, "OCR • ошибка • $lastOcrError"); showStatusPreservingDecision("Данные обновляются…"); processingOcr = false }
        } catch (error: Exception) { processingOcr = false; lastOcrError = error.message ?: "ошибка захвата"; CopilotState.addEvent(this, "CAPTURE • ошибка • $lastOcrError"); try { image.close() } catch (_: Exception) {} }
    }

    private fun updateState(text: String, frame: Bitmap) {
        val screen = GameScreenClassifier.classify(text)
        val event = GameParser.event(text)
        val vehicle = VehicleSnapshot(GameParser.name(text), GameParser.price(text), GameParser.hp(text),
            GameParser.mileage(text), GameParser.owners(text), GameParser.plate(text),
            GameParser.origin(text), GameParser.paintedParts(text), text)
        val balance = GameParser.balance(text) ?: CopilotState.balance(this)
        val garage = GameParser.garage(text) ?: CopilotState.garage(this)
        CopilotState.setBalance(this, balance)
        CopilotState.setGarage(this, garage)
        CopilotState.setSnapshot(this, vehicle)
        if (screen != lastScreenType) {
            lastScreenType = screen
            CopilotState.addEvent(this, "GAME • экран=" + screen + " • машина='" + vehicle.name + "' • баланс=" + balance)
        }
        if (event != null && event != lastGameEvent) {
            lastGameEvent = event
            CopilotState.addEvent(this, "GAME • событие=" + event)
        }
        lastVehicle = vehicle
        liveBridge.sendState(text, vehicle, balance, garage)
        val old = lastFrame
        lastFrame = if (frame.width > 720) Bitmap.createScaledBitmap(frame, 720, frame.height * 720 / frame.width, true)
        else frame.copy(Bitmap.Config.ARGB_8888, false)
        if (old != null) try { old.recycle() } catch (_: Exception) {}
        liveBridge.sendFrame(lastFrame!!)
        CopilotState.addEvent(this, "AI • кадр + состояние отправлены ChatGPT • экран=" + screen)
        showStatusPreservingDecision("ChatGPT анализирует текущую игру…")
    }

    private fun showNewsOverlay(code: String, limited: Boolean) { overlay?.post { overlay?.text = "🤖 CHATGPT • LIVE\n\n🎁 ПРОМОКОД НАЙДЕН\n\n/promo $code\n\n${if (limited) "⚠️ Активации ограничены\n\n" else ""}СЕЙЧАС: АКТИВИРОВАТЬ" } }
    private fun showOverlayDecision(opportunity: Opportunity, vehicle: VehicleSnapshot, screen: String) {
        overlay?.post {
            val action = opportunity.action.ifBlank { "ОЖИДАЙ" }
            val title = opportunity.title.ifBlank { "Жди подтверждения ситуации" }
            val reason = opportunity.reason.replace(Regex("\\s+"), " ").trim()
            val confidence = opportunity.confidence
            val price = vehicle.price?.let { String.format("%,d ₽", it).replace(',', ' ') } ?: "—"
            val hp = vehicle.hp?.let { it.toString() + " л.с." } ?: "—"
            val origin = vehicle.origin.ifBlank { "—" }
            val stats = LearningMemory.stats(this)
            overlay?.text = "🤖 COPILOT • LIVE\n\nСЕЙЧАС: " + action +
                "\n\n" + vehicle.name.ifBlank { screen.ifBlank { "Ситуация игры" } } +
                "\nЦена: " + price + " • Мощность: " + hp + "\nПроисхождение: " + origin +
                "\n\nЧТО ДЕЛАТЬ\n" + title +
                "\n\nПОЧЕМУ\n" + reason +
                "\n\nУверенность: " + confidence + "%\nИсточник решения: ChatGPT
        }
    }

    private fun showStatusPreservingDecision(message: String) { overlay?.post { val decision = lastOpportunity; if (decision != null) { overlay?.text = "🤖 COPILOT\n\nСЕЙЧАС: ${decision.action.ifBlank { "ОЖИДАЙ" }}\n\n${lastVehicle.name.ifBlank { "Ситуация игры" }}\n\nЧТО ДЕЛАТЬ\n${decision.title.ifBlank { "Жди подтверждения ситуации" }}\n\nСтатус: $message" } else overlay?.text = "🤖 COPILOT\n\nСЕЙЧАС: АНАЛИЗИРУЮ\n\nЧТО ДЕЛАТЬ\nПодожди подтверждения игровой ситуации\n\nСтатус: $message" } }
    private fun showOverlay() { if (!Settings.canDrawOverlays(this)) return; overlay = TextView(this).apply { text = "🤖 COPILOT\n\nСЕЙЧАС: АНАЛИЗИРУЮ\n\nЧТО ДЕЛАТЬ\nОжидаю игровой экран"; setTextColor(Color.WHITE); setBackgroundColor(0xEE111111.toInt()); setPadding(18,16,18,16); textSize=14f }; val manager=getSystemService(WINDOW_SERVICE) as WindowManager; val type=if(Build.VERSION.SDK_INT>=26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE; val params=WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.WRAP_CONTENT,type,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,PixelFormat.TRANSLUCENT); manager.addView(overlay,params) }
    private fun createChannel() { if(Build.VERSION.SDK_INT>=26){val manager=getSystemService(NOTIFICATION_SERVICE) as NotificationManager; manager.createNotificationChannel(NotificationChannel("copilot","Copilot",NotificationManager.IMPORTANCE_LOW))} }
    private fun releaseCaptureOnly() {
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { reader?.close() } catch (_: Exception) {}
        reader = null
        processingOcr = false
        captureReady = false
    }

    override fun onDestroy(){CopilotState.setMonitoring(this,false);processingOcr=false;try{commandServer.stop()}catch(_:Exception){};try{remotePoller.stop()}catch(_:Exception){};try{liveBridge.stop()}catch(_:Exception){};releaseCaptureOnly();if(!captureStopping){try{projection?.stop()}catch(_:Exception){}};projection=null;try{captureThread?.quitSafely()}catch(_:Exception){};captureThread=null;captureHandler=null;decisionHandler=null;try{overlay?.let{(getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it)}}catch(_:Exception){};overlay=null;try{lastFrame?.recycle()}catch(_:Exception){};lastFrame=null;super.onDestroy()}
    override fun onBind(intent: Intent?): IBinder?=null
}
