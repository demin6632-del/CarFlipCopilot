package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Persistent timeline of what Copilot saw in the game.
 * It is intentionally append-only and small so the assistant can reconstruct
 * chains such as screen -> action -> bid/offer -> expense -> sale -> profit.
 */
object GameMemory {
    private const val PREF = "copilot_game_memory"
    private const val KEY = "timeline"
    private const val MAX = 1000

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
        val o = JSONObject()
            .put("time", System.currentTimeMillis())
            .put("screen", screen)
            .put("event", event)
            .put("action", action)
            .put("plateState", plateState)
        amount?.let { o.put("amount", it) }
        vehicle?.let {
            o.put("name", it.name)
            o.put("plate", it.plate)
            it.price?.let { n -> o.put("price", n) }
        }
        val a = JSONArray(prefs(c).getString(KEY, "[]"))
        a.put(o)
        while (a.length() > MAX) a.remove(0)
        prefs(c).edit().putString(KEY, a.toString()).apply()
    }

    fun recent(c: Context, limit: Int = 30): List<String> {
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

    fun count(c: Context): Int = JSONArray(prefs(c).getString(KEY, "[]")).length()

    fun clear(c: Context) = prefs(c).edit().remove(KEY).apply()
}
