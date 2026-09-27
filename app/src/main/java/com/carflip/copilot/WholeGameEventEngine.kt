package com.carflip.copilot

import android.content.Context

/**
 * Converts OCR observations into durable whole-game events.
 * The monitor can call this on every accepted OCR frame; this class handles
 * deduplication so one on-screen event is not counted dozens of times.
 */
object WholeGameEventEngine {
    private const val PREF = "copilot_event_engine"

    private fun once(c: Context, kind: String, signature: String, windowMs: Long = 120_000L): Boolean {
        val p = c.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val k = "$kind:$signature"
        val now = System.currentTimeMillis()
        val old = p.getLong(k, 0L)
        if (old != 0L && now - old < windowMs) return false
        p.edit().putLong(k, now).apply()
        return true
    }

    fun observe(c: Context, text: String, screen: String, vehicle: VehicleSnapshot) {
        if (text.isBlank()) return

        GameMemory.sync(c)

        val purchase = GameParser.purchaseAmount(text)
        if (purchase != null && purchase > 0 &&
            once(c, "purchase", "${vehicle.plate}|${vehicle.name}|$purchase", 90_000L)) {
            CopilotState.recordPurchase(c, vehicle, purchase)
            GameMemory.record(c, screen, "ПОКУПКА", vehicle = vehicle, amount = purchase)
        }

        val sale = GameParser.saleAmount(text)
        val isPlateSale = GameParser.plateSaleEvent(text) != null
        if (sale != null && sale > 0 && !isPlateSale &&
            once(c, "sale", "${vehicle.plate}|${vehicle.name}|$sale", 90_000L)) {
            CopilotState.recordSale(c, vehicle, sale)
            GameMemory.record(c, screen, "ПРОДАЖА", vehicle = vehicle, amount = sale)
        }

        if (screen == "ПРОДАЖА") {
            val offer = GameParser.bidAmount(text) ?: GameParser.plateOffer(text)
            if (offer != null && offer > 0 &&
                once(c, "offer", "${vehicle.plate}|${vehicle.name}|$offer", 120_000L)) {
                val condition = when {
                    text.contains("убит", true) || text.contains("сильно", true) -> "тяжёлое состояние"
                    text.contains("крашен", true) || text.contains("ремонт", true) || text.contains("устал", true) -> "повреждения/уставшее состояние"
                    text.contains("пробег", true) -> "указан пробег"
                    else -> "текущее состояние"
                }
                CopilotState.addBuyerOffer(c, vehicle.plate, vehicle.name, condition, offer)
                GameMemory.record(c, screen, "ПРЕДЛОЖЕНИЕ_ПОКУПАТЕЛЯ", vehicle = vehicle, amount = offer)
            }
        }

        GameParser.action(text)?.let { action ->
            if (once(c, "action", "${vehicle.plate}|${vehicle.name}|$action", 90_000L)) {
                GameMemory.record(c, screen, "ДЕЙСТВИЕ", action, vehicle)

                // Store the real action cost now. When the car is later sold,
                // LearningMemory.recordAllActionOutcomes() attaches the realized
                // sale delta, allowing ActionRoiEngine to show realized ROI.
                if (screen == "УЛУЧШЕНИЕ") {
                    val cost = GameParser.expenseAmount(text)
                    if (cost != null && cost > 0) {
                        val forecast = CopilotState.dealForecast(c, vehicle)
                        val beforeSale = if (forecast.has("sale_price") && !forecast.isNull("sale_price")) forecast.optLong("sale_price") else null
                        LearningMemory.learnAction(c, vehicle, action, cost, 0L, beforeSale, "", vehicle.plate)
                    }
                }
            }
        }

        GameMemory.sync(c)
    }
}
