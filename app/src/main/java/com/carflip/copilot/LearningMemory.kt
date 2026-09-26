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
        history.put(JSONObject().put("feature", featureKey(v)).put("profit", profit).put("time", System.currentTimeMillis()))
        while (history.length() > 500) history.remove(0)
        val weights = JSONObject(pref.getString(WEIGHTS, "{}"))
        val key = featureKey(v)
        val old = weights.optDouble(key, 0.0)
        val reward = when {
            profit > 0 -> 1.0
            profit < 0 -> -1.0
            else -> 0.0
        }
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

    fun learnAction(c: Context, v: VehicleSnapshot, action: String, cost: Long, valueDelta: Long, beforeSale: Long? = null, dealId: String = "", plate: String = "") {
        val pref = p(c)
        val a = JSONArray(pref.getString("action_history", "[]"))
        val normalized = ActionRoiEngine.normalize(action)
        a.put(JSONObject()
            .put("feature", featureKey(v))
            .put("action", normalized)
            .put("cost", cost)
            .put("delta", valueDelta)
            .put("roi", if (cost > 0) ((valueDelta - cost).toDouble() / cost * 100.0) else 0.0)
            .put("beforeSale", beforeSale ?: JSONObject.NULL)
            .put("deal_id", dealId)
            .put("plate", plate)
            .put("time", System.currentTimeMillis()))
        while (a.length() > 500) a.remove(0)
        pref.edit().putString("action_history", a.toString()).apply()
    }

    fun estimatedSale(c: Context, v: VehicleSnapshot, fallback: Long? = null): Long? {
        val offers = CopilotState.buyerOffers(c, v.plate)
        val nums = offers.mapNotNull { Regex("(\\d+)").find(it)?.groupValues?.get(1)?.toLongOrNull() }.filter { it > 0 }
        return when {
            nums.isNotEmpty() -> nums.average().toLong()
            fallback != null -> fallback
            else -> v.price
        }
    }

    fun actionSamples(c: Context, v: VehicleSnapshot, action: String): Int {
        val a = JSONArray(p(c).getString("action_history", "[]"))
        var n = 0
        val normalized = ActionRoiEngine.normalize(action)
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: continue
            if (o.optString("feature") == featureKey(v) && ActionRoiEngine.normalize(o.optString("action")) == normalized) n++
        }
        return n
    }

    fun actionRoi(c: Context, v: VehicleSnapshot, action: String): Double? {
        val a = JSONArray(p(c).getString("action_history", "[]"))
        var sum = 0.0
        var n = 0
        val normalized = ActionRoiEngine.normalize(action)
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: continue
            if (o.optString("feature") == featureKey(v) && ActionRoiEngine.normalize(o.optString("action")) == normalized) {
                sum += o.optDouble("roi")
                n++
            }
        }
        return if (n == 0) null else sum / n
    }

    fun recordActionOutcome(c: Context, v: VehicleSnapshot, action: String, afterSale: Long, dealId: String = "", plate: String = "") {
        val pref = p(c)
        val a = JSONArray(pref.getString("action_history", "[]"))
        val normalized = ActionRoiEngine.normalize(action)
        var changed = false
        for (i in a.length() - 1 downTo 0) {
            val o = a.optJSONObject(i) ?: continue
            if (ActionRoiEngine.normalize(o.optString("action")) != normalized) continue
            if (o.has("realizedDelta")) continue
            if (dealId.isNotEmpty() && o.optString("deal_id") != dealId) continue
            if (plate.isNotEmpty() && o.optString("plate").isNotEmpty() && o.optString("plate") != plate) continue
            val before = o.optLong("beforeSale", 0L)
            if (before <= 0L) continue
            o.put("realizedDelta", afterSale - before)
                .put("afterSale", afterSale)
                .put("outcomeTime", System.currentTimeMillis())
            a.put(i, o)
            changed = true
        }
        if (changed) pref.edit().putString("action_history", a.toString()).apply()
    }

    fun recordAllActionOutcomes(c: Context, v: VehicleSnapshot, afterSale: Long, dealId: String = "", plate: String = "") {
        val pref = p(c)
        val a = JSONArray(pref.getString("action_history", "[]"))
        var changed = false
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: continue
            if (o.has("realizedDelta")) continue
            if (dealId.isNotEmpty() && o.optString("deal_id") != dealId) continue
            if (plate.isNotEmpty() && o.optString("plate").isNotEmpty() && o.optString("plate") != plate) continue
            val before = o.optLong("beforeSale", 0L)
            if (before <= 0L) continue
            o.put("realizedDelta", afterSale - before)
                .put("afterSale", afterSale)
                .put("outcomeTime", System.currentTimeMillis())
            a.put(i, o)
            changed = true
        }
        if (changed) pref.edit().putString("action_history", a.toString()).apply()
    }

    fun reset(c: Context) {
        p(c).edit().clear().apply()
    }
}