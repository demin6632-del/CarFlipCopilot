package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

data class CapitalProfile(
    val locked: Long,
    val utilizationPercent: Double,
    val holdingDays: Double?,
    val turnoverConfidence: Int,
    val pressure: Int,
    val garagePressure: Int
)

object CapitalAnalyzer {
    private fun median(values: List<Double>): Double? {
        if (values.isEmpty()) return null
        val s = values.sorted()
        val m = s.size / 2
        return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2.0
    }

    fun holdingDays(c: Context, name: String): Pair<Double?, Int> {
        val exact = CopilotState.deals(c).filter {
            it.buy != null && it.sell != null && it.opened > 0L && (it.name.equals(name, true))
        }.mapNotNull { d ->
            val end = d.closed ?: return@mapNotNull null
            if (end <= d.opened) null else (end - d.opened).toDouble() / 86_400_000.0
        }
        if (exact.isNotEmpty()) return Pair(median(exact), minOf(95, 70 + exact.size * 10))

        val target = name.lowercase().replace('ё', 'е').split(Regex("[^a-zа-я0-9]+")).filter { it.length >= 3 }.toSet()
        if (target.isEmpty()) return Pair(null, 0)
        val similar = CopilotState.deals(c).filter { it.buy != null && it.sell != null && it.opened > 0L && it.closed != null }.mapNotNull { d ->
            val other = d.name.lowercase().replace('ё', 'е').split(Regex("[^a-zа-я0-9]+")).filter { it.length >= 3 }.toSet()
            val common = target.intersect(other).size
            if (common >= 2 || (target.size == 1 && common == 1)) {
                val end = d.closed ?: return@mapNotNull null
                if (end > d.opened) (end - d.opened).toDouble() / 86_400_000.0 else null
            } else null
        }
        return Pair(median(similar), if (similar.isEmpty()) 0 else minOf(65, 35 + similar.size * 8))
    }

    fun profile(c: Context, price: Long, fees: Long = 0L, name: String = ""): CapitalProfile {
        val balance = CopilotState.balance(c) ?: 0L
        val locked = (price + fees).coerceAtLeast(0L)
        val utilization = if (balance > 0L) locked.toDouble() / balance * 100.0 else 100.0
        val pressure = when {
            utilization >= 80.0 -> 90
            utilization >= 60.0 -> 70
            utilization >= 40.0 -> 50
            utilization >= 25.0 -> 30
            else -> 10
        }
        val garage = CopilotState.garage(c)
        val garagePressure = when {
            garage >= 3 -> 100
            garage == 2 -> 70
            garage == 1 -> 35
            else -> 0
        }
        val (days, confidence) = if (name.isBlank()) Pair(null, 0) else holdingDays(c, name)
        return CapitalProfile(locked, utilization, days, confidence, pressure, garagePressure)
    }

    fun snapshot(c: Context): JSONObject {
        val v = CopilotState.snapshot(c)
        val current = if (v.price != null && v.price > 0L) profile(c, v.price, 0L, v.name) else null
        val out = JSONObject()
        out.put("current", current?.let { json(it) })
        out.put("source", "observed_balance_and_deal_history")
        out.put("holding_time_unknown_without_completed_history", current?.holdingDays == null)
        return out
    }

    fun candidateJson(c: Context, price: Long, fees: Long, name: String): JSONObject =
        json(profile(c, price, fees, name))

    private fun json(x: CapitalProfile): JSONObject = JSONObject()
        .put("capital_locked", x.locked)
        .put("capital_utilization_percent", (x.utilizationPercent * 10.0).roundToInt() / 10.0)
        .put("holding_days_estimate", x.holdingDays?.let { (it * 10.0).roundToInt() / 10.0 })
        .put("turnover_confidence", x.turnoverConfidence)
        .put("capital_pressure", x.pressure)
        .put("garage_pressure", x.garagePressure)
}
