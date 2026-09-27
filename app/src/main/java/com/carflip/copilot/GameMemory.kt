package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Persistent whole-game timeline. It also imports the existing event journal,
 * so the feature works immediately with older app data. */
object GameMemory {
    private const val PREF = "copilot_game_memory"
    private const val KEY = "timeline"
    private const val MAX = 1000
    private const val SYNC = "last_event_count"

    private fun prefs(c: Context) = c.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    fun record(
        c: Context,
        screen: String = "",
        event: String = "",
        action: String = "",
        vehicle: VehicleSnapshot? = null,
        amount: Long? = null,
        plateState: String = ""
    ) {
        val o = JSONObject().put("time", System.currentTimeMillis())
            .put("screen", screen).put("event", event)
            .put("action", action).put("plateState", plateState)
        amount?.let { o.put("amount", it) }
        vehicle?.let {
            o.put("name", it.name).put("plate", it.plate)
            it.price?.let { n -> o.put("price", n) }
        }
        val a = JSONArray(prefs(c).getString(KEY, "[]"))
        a.put(o)
        while (a.length() > MAX) a.remove(0)
        prefs(c).edit().putString(KEY, a.toString()).apply()
    }

    /** Mirrors CopilotState's event journal into a structured memory timeline. */
    fun sync(c: Context) {
        val events = CopilotState.events(c).asReversed()
        val p = prefs(c)
        val seen = p.getInt(SYNC, 0).coerceIn(0, events.size)
        if (seen == events.size) return
        val v = CopilotState.snapshot(c)
        for (i in seen until events.size) {
            val text = events[i]
            val screen = Regex("экран=([^•]+)").find(text)?.groupValues?.getOrNull(1)?.trim() ?: ""
            val action = Regex("действие=([^•]+)").find(text)?.groupValues?.getOrNull(1)?.trim() ?: ""
            val amount = Regex("(?:=|выплата=|покупка=|продажа=|расход=|ставка/предложение=)(\\d+)\\s*₽")
                .find(text)?.groupValues?.getOrNull(1)?.toLongOrNull()
            val state = when {
                text.contains("АУКЦИОН_НОМЕРА_БЕЗ_СТАВОК", true) -> "STORAGE_NO_BID"
                text.contains("ПРОДАЖА_НОМЕРА", true) -> "SOLD"
                else -> ""
            }
            record(c, screen, text, action, v.takeIf { it.name.isNotBlank() || it.plate.isNotBlank() }, amount, state)
        }
        p.edit().putInt(SYNC, events.size).apply()
    }

    fun recent(c: Context, limit: Int = 30): List<String> {
        sync(c)
        val a = JSONArray(prefs(c).getString(KEY, "[]"))
        val from = (a.length() - limit.coerceAtMost(a.length())).coerceAtLeast(0)
        return (a.length() - 1 downTo from).mapNotNull { i ->
            val o = a.optJSONObject(i) ?: return@mapNotNull null
            val parts = mutableListOf<String>()
            o.optString("screen").takeIf { it.isNotBlank() }?.let { parts += it }
            o.optString("event").takeIf { it.isNotBlank() }?.let { parts += it }
            o.optString("action").takeIf { it.isNotBlank() }?.let { parts += "action=$it" }
            o.optString("plateState").takeIf { it.isNotBlank() }?.let { parts += "plate=$it" }
            o.optString("plate").takeIf { it.isNotBlank() }?.let { parts += "№$it" }
            o.optLong("amount").takeIf { o.has("amount") }?.let { parts += "${it} ₽" }
            parts.joinToString(" • ").takeIf { it.isNotBlank() }
        }
    }

    fun count(c: Context): Int { sync(c); return JSONArray(prefs(c).getString(KEY, "[]")).length() }
    fun clear(c: Context) = prefs(c).edit().remove(KEY).remove(SYNC).apply()
}
