package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

data class LearningStats(
    val samples: Int,
    val profitable: Int,
    val loss: Int,
    val avgProfit: Long,
    val accuracy: Int
)

object LearningMemory {
    private const val PREF = "copilot_learning"
    private const val HISTORY = "history"
    private const val WEIGHTS = "weights"

    private fun p(c: Context) = c.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    private fun featureKey(v: VehicleSnapshot): String {
        val origin = v.origin.ifBlank { "UNKNOWN" }
        val hpBand = when {
            (v.hp ?: 0) >= 600 -> "600+"
            (v.hp ?: 0) >= 400 -> "400-599"
            (v.hp ?: 0) >= 300 -> "300-399"
            else -> "<300"
        }
        val priceBand = when {
            (v.price ?: Long.MAX_VALUE) <= 1000000 -> "0-1m"
            (v.price ?: Long.MAX_VALUE) <= 2000000 -> "1-2m"
            (v.price ?: Long.MAX_VALUE) <= 2500000 -> "2-2.5m"
            else -> "2.5m+"
        }
        return "$origin|$hpBand|$priceBand"
    }

    fun learn(c: Context, v: VehicleSnapshot, profit: Long) {
        val pref = p(c)
        val history = JSONArray(pref.getString(HISTORY, "[]"))
        history.put(JSONObject()
            .put("feature", featureKey(v))
            .put("profit", profit)
            .put("time", System.currentTimeMillis()))
        while (history.length() > 500) history.remove(0)

        val weights = JSONObject(pref.getString(WEIGHTS, "{}"))
        val key = featureKey(v)
        val old = weights.optDouble(key, 0.0)
        val reward = when {
            profit > 0 -> 1.0
            profit < 0 -> -1.0
            else -> 0.0
        }
        // Online learning: the weight moves toward the latest observed result.
        weights.put(key, (old * 0.85 + reward * 0.15).coerceIn(-1.0, 1.0))
        pref.edit().putString(HISTORY, history.toString()).putString(WEIGHTS, weights.toString()).apply()
    }

    fun score(c: Context, v: VehicleSnapshot): Int {
        val w = JSONObject(p(c).getString(WEIGHTS, "{}")).optDouble(featureKey(v), 0.0)
        return (w * 12.0).roundToInt()
    }

    fun stats(c: Context): LearningStats {
        val a = JSONArray(p(c).getString(HISTORY, "[]"))
        var profitable = 0
        var loss = 0
        var sum = 0L
        for (i in 0 until a.length()) {
            val n = a.optJSONObject(i)?.optLong("profit") ?: 0L
            sum += n
            if (n > 0) profitable++ else if (n < 0) loss++
        }
        val samples = a.length()
        val accuracy = if (samples == 0) 0 else ((profitable.toDouble() / samples) * 100.0).roundToInt()
        return LearningStats(samples, profitable, loss, if (samples == 0) 0 else sum / samples, accuracy)
    }

    fun reset(c: Context) {
        p(c).edit().clear().apply()
    }
}
