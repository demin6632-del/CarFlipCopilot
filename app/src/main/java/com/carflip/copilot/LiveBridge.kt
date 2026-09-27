package com.carflip.copilot

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import okhttp3.*
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class LiveBridge(
    private val context: Context,
    private val onCommand: (String) -> Unit,
    private val onStatus: (Boolean) -> Unit = {}
) {
    private val prefs = context.getSharedPreferences("live_bridge", Context.MODE_PRIVATE)
    private var client: OkHttpClient? = null
    private var socket: WebSocket? = null
    private val reconnectExecutor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var connected = false
    @Volatile private var stopped = true
    @Volatile private var reconnectScheduled = false

    fun configure(url: String, token: String) {
        prefs.edit().putString("url", url.trim()).putString("token", token.trim()).apply()
    }

    fun url(): String = prefs.getString("url", "") ?: ""
    fun token(): String = prefs.getString("token", "") ?: ""
    fun isConnected(): Boolean = connected

    fun start() {
        stopped = false
        connectNow()
    }

    private fun connectNow() {
        if (stopped || connected || reconnectScheduled) return
        val u = url()
        if (u.isBlank()) {
            prefs.edit().putBoolean("connected", false).apply()
            onStatus(false)
            return
        }
        reconnectScheduled = false
        try {
            socket?.cancel()
            client?.dispatcher?.cancelAll()
            client?.connectionPool?.evictAll()
            client = OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .connectTimeout(10, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .pingInterval(15, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()
            val request = Request.Builder()
                .url(u)
                .header("Authorization", "Bearer " + token())
                .header("User-Agent", "CarFlipCopilot/1.1")
                .build()
            socket = client!!.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) {
                    connected = true
                    prefs.edit().putBoolean("connected", true).apply()
                    onStatus(true)
                    send(JSONObject()
                        .put("type", "hello")
                        .put("device", "android")
                        .put("app", "CarFlipCopilot")
                        .put("version", "1.1")
                        .put("time", System.currentTimeMillis())
                        .toString())
                    CopilotState.addEvent(context, "LIVE • WebSocket подключён")
                }

                override fun onMessage(ws: WebSocket, text: String) {
                    try {
                        val o = JSONObject(text)
                        when (o.optString("type")) {
                            "command" -> onCommand(o.optString("command"))
                            "attachment_analysis" ->
                                onCommand("ATTACHMENT_ANALYSIS|" + o.optString("name") + "|" + o.optString("analysis"))
                            "attachment_analysis_error" ->
                                onCommand("ATTACHMENT_ANALYSIS_ERROR|" + o.optString("error"))
                            "ping" -> send(JSONObject().put("type", "pong").put("time", System.currentTimeMillis()).toString())
                        }
                    } catch (_: Exception) {}
                }

                override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                    connected = false
                    prefs.edit().putBoolean("connected", false).apply()
                    onStatus(false)
                }

                override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                    connected = false
                    prefs.edit().putBoolean("connected", false).apply()
                    onStatus(false)
                    scheduleReconnect("closed:" + code)
                }

                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                    connected = false
                    prefs.edit().putBoolean("connected", false).apply()
                    onStatus(false)
                    CopilotState.addEvent(context, "LIVE • ошибка • " + (t.message ?: "WebSocket"))
                    scheduleReconnect("failure")
                }
            })
        } catch (e: Exception) {
            connected = false
            prefs.edit().putBoolean("connected", false).apply()
            onStatus(false)
            CopilotState.addEvent(context, "LIVE • ошибка запуска • " + (e.message ?: "WebSocket"))
            scheduleReconnect("exception")
        }
    }

    private fun scheduleReconnect(reason: String) {
        if (stopped || connected || reconnectScheduled) return
        reconnectScheduled = true
        CopilotState.addEvent(context, "LIVE • переподключение через 5с • " + reason)
        reconnectExecutor.schedule({
            reconnectScheduled = false
            connectNow()
        }, 5, TimeUnit.SECONDS)
    }

    fun sendState(text: String, v: VehicleSnapshot, balance: Long, garage: Int, decision: String, opportunity: Opportunity) {
        if (!connected) return
        send(JSONObject()
            .put("type", "state")
            .put("time", System.currentTimeMillis())
            .put("ocr", text)
            .put("balance", balance)
            .put("garage", garage)
            .put("decision", decision)
            .put("action", opportunity.action)
            .put("confidence", opportunity.confidence)
            .put("title", opportunity.title)
            .put("reason", opportunity.reason)
            .put("vehicle", JSONObject()
                .put("name", v.name)
                .put("price", v.price)
                .put("hp", v.hp)
                .put("mileage", v.mileage)
                .put("owners", v.owners)
                .put("plate", v.plate)
                .put("origin", v.origin)
                .put("paintedParts", v.paintedParts))
            .toString())
    }

    fun sendFrame(bitmap: Bitmap) {
        if (!connected) return
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 55, out)
        send(JSONObject().put("type", "frame").put("time", System.currentTimeMillis())
            .put("jpegBase64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)).toString())
    }

    fun sendAttachment(uri: Uri): Boolean {
        if (!connected) return false
        return try {
            val resolver = context.contentResolver
            val mime = resolver.getType(uri) ?: "application/octet-stream"
            var name = "attachment"
            var size = -1L
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (ni >= 0) c.getString(ni)?.let { name = it }
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
            val id = UUID.randomUUID().toString()
            send(JSONObject().put("type", "attachment_start").put("id", id).put("name", name)
                .put("mime", mime).put("size", size).put("time", System.currentTimeMillis()).toString())
            val input = resolver.openInputStream(uri) ?: return false
            input.use {
                val buf = ByteArray(48 * 1024)
                var index = 0
                while (true) {
                    val n = it.read(buf)
                    if (n <= 0) break
                    if (!connected) return false
                    send(JSONObject().put("type", "attachment_chunk").put("id", id).put("index", index++)
                        .put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)).toString())
                }
            }
            send(JSONObject().put("type", "attachment_end").put("id", id).toString())
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun send(value: String) {
        socket?.send(value)
    }

    fun stop() {
        stopped = true
        reconnectScheduled = false
        connected = false
        prefs.edit().putBoolean("connected", false).apply()
        onStatus(false)
        socket?.close(1000, "stop")
        socket = null
        client?.dispatcher?.cancelAll()
        client?.connectionPool?.evictAll()
        client = null
    }
}
