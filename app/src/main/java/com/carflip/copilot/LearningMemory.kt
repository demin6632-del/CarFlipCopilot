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

data class SalePriceEstimate(
    val price: Long?,
    val samples: Int,
    val confidence: Int
)

object LearningMemory {
    private const val PREF = "copilot_learning"
    private const val HISTORY = "history"
    private const val WEIGHTS = "weights"
    private const val SITUATION = "situation"

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

    fun setCurrentSituation(c: Context, signature: String) {
        p(c).edit().putString(SITUATION, signature).apply()
    }

    fun situationScore(c: Context): Int {
        val key = p(c).getString(SITUATION, "") ?: ""
        if (key.isBlank()) return 0
        val weights = JSONObject(p(c).getString(WEIGHTS, "{}"))
        return (weights.optDouble("SITUATION:" + key, 0.0) * 20.0).roundToInt()
    }

    fun learn(c: Context, v: VehicleSnapshot, profit: Long, purchasePrice: Long? = v.price, salePrice: Long? = null) {
        val pref = p(c)
        val history = JSONArray(pref.getString(HISTORY, "[]"))
        history.put(JSONObject()
            .put("feature", featureKey(v))
            .put("profit", profit)
            .put("purchasePrice", purchasePrice ?: 0L)
            .put("salePrice", salePrice ?: 0L)
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
        val situation = pref.getString(SITUATION, "") ?: ""
        if (situation.isNotBlank()) {
            val skey = "SITUATION:" + situation
            val sold = weights.optDouble(skey, 0.0)
            weights.put(skey, (sold * 0.85 + reward * 0.15).coerceIn(-1.0, 1.0))
        }
        pref.edit().putString(HISTORY, history.toString()).putString(WEIGHTS, weights.toString()).apply()
    }

    fun score(c: Context, v: VehicleSnapshot): Int {
        val w = JSONObject(p(c).getString(WEIGHTS, "{}")).optDouble(featureKey(v), 0.0)
        return (w * 12.0).roundToInt()
    }

    fun estimateSalePrice(c: Context, v: VehicleSnapshot): SalePriceEstimate {
        val purchase = v.price ?: return SalePriceEstimate(null, 0, 0)
        val key = featureKey(v)
        val a = JSONArray(p(c).getString(HISTORY, "[]"))
        val ratios = mutableListOf<Double>()
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: continue
            if (o.optString("feature") != key) continue
            val buy = o.optLong("purchasePrice", 0L)
            val sell = o.optLong("salePrice", 0L)
            if (buy > 0L && sell > 0L) ratios += sell.toDouble() / buy.toDouble()
        }
        if (ratios.isEmpty()) return SalePriceEstimate(null, 0, 0)
        ratios.sort()
        val median = ratios[ratios.size / 2]
        val estimate = (purchase * median).toLong()
        val confidence = when {
            ratios.size >= 20 -> 90
            ratios.size >= 10 -> 80
            ratios.size >= 5 -> 70
            else -> 55
        }
        return SalePriceEstimate(estimate, ratios.size, confidence)
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
