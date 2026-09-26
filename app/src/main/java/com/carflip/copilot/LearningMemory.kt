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

data class ActionRoi(
    val action: String,
    val cost: Long,
    val priceDelta: Long,
    val roi: Long,
    val samples: Int
)

object LearningMemory {
    private const val PREF = "copilot_learning"
    private const val HISTORY = "history"
    private const val WEIGHTS = "weights"
    private const val SITUATION = "situation"
    private const val OFFERS = "offers"

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

    fun recordOffer(c: Context, v: VehicleSnapshot, offer: Long) {
        if (v.name.isBlank()) return
        val pref = p(c)
        val a = JSONArray(pref.getString(OFFERS, "[]"))
        val state = stateKey(v)
        val key = (v.plate.ifBlank { v.name } + "|" + offer + "|" + state)
        for (i in 0 until a.length()) {
            if (a.optJSONObject(i)?.optString("key") == key) return
        }
        a.put(JSONObject()
            .put("key", key)
            .put("name", v.name)
            .put("plate", v.plate)
            .put("offer", offer)
            .put("state", state)
            .put("hp", v.hp ?: 0)
            .put("stage", v.stage ?: 0)
            .put("paintedParts", v.paintedParts ?: -1)
            .put("invested", v.invested ?: 0L)
            .put("polish", v.polishApplied == true)
            .put("time", System.currentTimeMillis()))
        while (a.length() > 500) a.remove(0)
        pref.edit().putString(OFFERS, a.toString()).apply()
    }

    private fun stateKey(v: VehicleSnapshot): String =
        listOf(v.name, v.hp ?: -1, v.stage ?: -1, v.paintedParts ?: -1, v.polishApplied ?: false).joinToString("|")

    private fun detectAction(old: JSONObject, current: VehicleSnapshot): String? {
        val oldHp = old.optInt("hp", 0)
        val oldStage = old.optInt("stage", 0)
        val oldPaint = old.optInt("paintedParts", -1)
        val oldPolish = old.optBoolean("polish", false)

        val stageChanged = current.stage != null && current.stage != oldStage
        val polishChanged = current.polishApplied == true && !oldPolish
        val paintChanged = current.paintedParts != null && oldPaint >= 0 && current.paintedParts != oldPaint
        if (listOf(stageChanged, polishChanged, paintChanged).count { it } != 1) return null

        if (stageChanged) return if ((current.hp ?: 0) - oldHp >= 60) "ТУРБО" else "ЧИП"
        if (polishChanged) return "ПОЛИРОВКА"
        return "ОКРАС"
    }

    private fun snapshotFromOffer(o: JSONObject): VehicleSnapshot =
        VehicleSnapshot(
            name = o.optString("name"),
            hp = o.optInt("hp", 0),
            stage = o.optInt("stage", 0),
            paintedParts = o.optInt("paintedParts", -1),
            invested = o.optLong("invested", 0L),
            polishApplied = o.optBoolean("polish", false)
        )

    fun actionRoi(c: Context, v: VehicleSnapshot, offer: Long): List<ActionRoi> {
        val id = v.plate.ifBlank { v.name }
        if (id.isBlank()) return emptyList()
        val a = JSONArray(p(c).getString(OFFERS, "[]"))
        val currentState = stateKey(v)
        var previous: JSONObject? = null
        for (i in a.length() - 1 downTo 0) {
            val o = a.optJSONObject(i) ?: continue
            if (o.optString("plate").ifBlank { o.optString("name") } != id) continue
            if (o.optString("state") == currentState) continue
            previous = o
            break
        }
        val old = previous ?: return emptyList()
        val action = detectAction(old, v) ?: return emptyList()
        val cost = ((v.invested ?: 0L) - old.optLong("invested", 0L)).coerceAtLeast(0L)
        val delta = offer - old.optLong("offer", 0L)
        return listOf(ActionRoi(action, cost, delta, delta - cost, 1))
    }

    fun actionRoiStats(c: Context, v: VehicleSnapshot): List<ActionRoi> {
        val id = v.plate.ifBlank { v.name }
        if (id.isBlank()) return emptyList()
        val a = JSONArray(p(c).getString(OFFERS, "[]"))
        val rows = mutableListOf<ActionRoi>()
        var previous: JSONObject? = null

        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: continue
            if (o.optString("plate").ifBlank { o.optString("name") } != id) continue
            if (previous != null && o.optString("state") != previous!!.optString("state")) {
                val old = previous!!
                val current = snapshotFromOffer(o)
                val action = detectAction(old, current)
                if (action != null) {
                    val cost = (o.optLong("invested", 0L) - old.optLong("invested", 0L)).coerceAtLeast(0L)
                    val delta = o.optLong("offer", 0L) - old.optLong("offer", 0L)
                    rows += ActionRoi(action, cost, delta, delta - cost, 1)
                }
            }
            previous = o
        }

        return rows.groupBy { it.action }.map { (action, list) ->
            fun median(values: List<Long>): Long {
                val sorted = values.sorted()
                return sorted[sorted.size / 2]
            }
            ActionRoi(
                action = action,
                cost = median(list.map { it.cost }),
                priceDelta = median(list.map { it.priceDelta }),
                roi = median(list.map { it.roi }),
                samples = list.size
            )
        }.sortedBy { it.action }
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
