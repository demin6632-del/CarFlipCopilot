package com.carflip.copilot

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class RemoteCommandPoller(private val context: Context) {
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private var running = false
    private val repoUrl = "https://api.github.com/repos/demin6632-del/CarFlipCopilot/contents/remote/command.json?ref=main"
    private val task = object : Runnable {
        override fun run() {
            if (!running) return
            executor.execute { poll() }
            handler.postDelayed(this, 15000)
        }
    }

    fun start() {
        if (running) return
        running = true
        handler.post(task)
    }

    fun stop() {
        running = false
        handler.removeCallbacks(task)
        executor.shutdownNow()
    }

    private fun poll() {
        try {
            val c = URL(repoUrl).openConnection() as HttpURLConnection
            c.connectTimeout = 5000
            c.readTimeout = 5000
            c.setRequestProperty("Accept", "application/vnd.github+json")
            c.setRequestProperty("User-Agent", "CarFlipCopilot")
            val body = c.inputStream.bufferedReader().use { it.readText() }
            c.disconnect()
            val outer = JSONObject(body)
            val encoded = outer.optString("content").replace("\\n", "")
            if (encoded.isBlank()) return
            val command = JSONObject(String(android.util.Base64.decode(encoded, android.util.Base64.DEFAULT), Charsets.UTF_8))
            val id = command.optString("id")
            val last = context.getSharedPreferences("copilot_state", Context.MODE_PRIVATE).getString("remote_command_id", "")
            if (id.isBlank() || id == last) return
            context.getSharedPreferences("copilot_state", Context.MODE_PRIVATE).edit().putString("remote_command_id", id).apply()
            when (command.optString("command").trim().uppercase()) {
                "START", "MONITOR", "МОНИТОРИНГ" -> {
                    CopilotState.addEvent(context, "REMOTE • команда START получена")
                    CopilotState.setDecision(context, "СМОТРЮ…")
                }
                "STOP" -> {
                    CopilotState.addEvent(context, "REMOTE • команда STOP получена")
                    handler.post { context.stopService(android.content.Intent(context, ScreenMonitorService::class.java)) }
                }
                "STATUS", "STATE", "СОСТОЯНИЕ" -> {
                    CopilotState.addEvent(context, "REMOTE • запрос состояния получен")
                }
                "CLEAR", "ОЧИСТИТЬ" -> {
                    CopilotState.setDecision(context, "СМОТРЮ…")
                    CopilotState.addEvent(context, "REMOTE • решение сброшено")
                }
                "NOOP", "" -> Unit
                else -> CopilotState.addEvent(context, "REMOTE • неизвестная команда: " + command.optString("command"))
            }
        } catch (_: Exception) {
        }
    }
}
