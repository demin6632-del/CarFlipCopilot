package com.carflip.copilot
import android.content.Context
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.UUID
import kotlin.concurrent.thread

class CommandServer(private val context: Context) {
    private var server: ServerSocket? = null
    @Volatile private var running = false
    private val port = 18765
    private fun token(): String {
        val p = context.getSharedPreferences("copilot_state", Context.MODE_PRIVATE)
        var t = p.getString("api_token", null)
        if (t.isNullOrBlank()) {
            t = UUID.randomUUID().toString().replace("-", "")
            p.edit().putString("api_token", t).apply()
        }
        return t
    }
    fun start() {
        if (running) return
        running = true
        thread(name = "copilot-command-server") {
            try {
                server = ServerSocket(port, 20, java.net.InetAddress.getByName("127.0.0.1"))
                while (running) {
                    val socket = server?.accept() ?: break
                    thread { handle(socket) }
                }
            } catch (_: Exception) {}
            finally { running = false; try { server?.close() } catch (_: Exception) {}; server = null }
        }
    }
    fun stop() { running = false; try { server?.close() } catch (_: Exception) {}; server = null }
    fun tokenValue(): String = token()
    private fun handle(socket: Socket) {
        socket.use { s ->
            try {
                s.soTimeout = 3000
                val input = s.getInputStream().bufferedReader()
                val request = input.readLine() ?: return
                val path = request.split(" ").getOrNull(1) ?: "/"
                while (true) { val line = input.readLine() ?: break; if (line.isEmpty()) break }
                val uri = java.net.URI("http://127.0.0.1" + path)
                val query = parseQuery(uri.rawQuery ?: "")
                if (query["token"] != token()) { respond(s, 401, """{"ok":false,"error":"unauthorized"}"""); return }
                when (uri.path) {
                    "/status" -> respond(s, 200, statusJson())
                    "/command" -> respond(s, 200, command(query["cmd"] ?: ""))
                    else -> respond(s, 404, """{"ok":false,"error":"not_found"}""")
                }
            } catch (_: Exception) {}
        }
    }
    private fun parseQuery(raw: String): Map<String, String> = raw.split("&").filter { it.isNotEmpty() }.associate {
        val p = it.split("=", limit = 2); URLDecoder.decode(p[0], "UTF-8") to URLDecoder.decode(p.getOrElse(1) { "" }, "UTF-8")
    }
    private fun statusJson(): String {
        val v = CopilotState.snapshot(context)
        val o = org.json.JSONObject().put("ok", true).put("decision", CopilotState.decision(context)).put("balance", CopilotState.balance(context)).put("garage", CopilotState.garage(context)).put("monitoring", CopilotState.monitoring(context))
        o.put("vehicle", org.json.JSONObject().apply { put("name", v.name); put("price", v.price); put("hp", v.hp); put("mileage", v.mileage); put("owners", v.owners); put("plate", v.plate); put("origin", v.origin); put("paintedParts", v.paintedParts); put("updatedAt", v.updatedAt) })
        o.put("deals", org.json.JSONArray().apply { CopilotState.deals(context).take(30).forEach { d -> put(org.json.JSONObject().apply { put("name", d.name); put("plate", d.plate); put("buy", d.buy); put("sell", d.sell); put("fees", d.fees); put("closed", d.closed) }) } })
        o.put("plates", org.json.JSONArray().apply { CopilotState.plates(context).take(30).forEach { p -> put(org.json.JSONObject().apply { put("plate", p.plate); put("state", p.state); put("value", p.value); put("updated", p.updated) }) } })
        o.put("events", org.json.JSONArray(CopilotState.events(context).take(30)))
        return o.toString()
    }
    private fun command(raw: String): String = when (raw.trim().lowercase()) {
        "status", "state", "состояние", "vehicle", "машина", "авто" -> statusJson()
        "deals", "сделки" -> org.json.JSONObject().put("ok", true).put("deals", org.json.JSONArray(CopilotState.deals(context).take(100).map { d -> org.json.JSONObject().put("name", d.name).put("plate", d.plate).put("buy", d.buy).put("sell", d.sell).put("fees", d.fees).put("profit", if (d.buy != null && d.sell != null) d.sell - d.buy - d.fees else null) })).toString()
        "plates", "номера" -> org.json.JSONObject().put("ok", true).put("plates", org.json.JSONArray(CopilotState.plates(context).take(100).map { p -> org.json.JSONObject().put("plate", p.plate).put("state", p.state).put("value", p.value) })).toString()
        "events", "события" -> org.json.JSONObject().put("ok", true).put("events", org.json.JSONArray(CopilotState.events(context).take(100))).toString()
        else -> org.json.JSONObject().put("ok", false).put("error", "unknown_command").put("command", raw).toString()
    }
    private fun respond(socket: Socket, code: Int, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val out = socket.getOutputStream().bufferedWriter()
        val status = if (code == 200) "OK" else "Error"
        out.write("HTTP/1.1 " + code + " " + status + "\r\n")
        out.write("Content-Type: application/json; charset=utf-8\r\n")
        out.write("Content-Length: " + bytes.size + "\r\n")
        out.write("Connection: close\r\n\r\n"); out.flush()
        socket.getOutputStream().write(bytes); socket.getOutputStream().flush()
    }
}