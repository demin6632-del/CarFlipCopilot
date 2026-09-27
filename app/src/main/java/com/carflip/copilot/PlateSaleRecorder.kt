package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Фиксирует результат продажи номера один раз для конкретной выплаты. */
object PlateSaleRecorder {
    private const val PREF = "copilot_state"

    fun record(c: Context, sale: GameParser.PlateSaleEvent): Boolean {
        if (sale.plate.isBlank() || sale.payout <= 0) return false
        val prefs = c.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val key = "plate_sale_recorded:${sale.plate}:${sale.payout}"
        if (prefs.getBoolean(key, false)) return false

        val ledgerRaw = prefs.getString("ledger", "[]") ?: "[]"
        val ledger = JSONArray(ledgerRaw)
        ledger.put(
            JSONObject()
                .put("type", "ПРОДАЖА_НОМЕРА")
                .put("amount", sale.payout)
                .put("note", "Аукцион • ${sale.plate} • комиссия ${sale.commission} ₽")
                .put("time", System.currentTimeMillis())
        )
        while (ledger.length() > 500) ledger.remove(0)

        val eventsRaw = prefs.getString("events", "[]") ?: "[]"
        val events = JSONArray(eventsRaw)
        events.put(
            JSONObject()
                .put("text", "НОМЕР • ${sale.plate} ПРОДАН С АУКЦИОНА • выплата ${sale.payout} ₽ • комиссия ${sale.commission} ₽${sale.commissionPercent?.let { " (${it}%)" } ?: ""}${sale.gross?.let { " • до комиссии ${it} ₽" } ?: ""}")
                .put("time", System.currentTimeMillis())
        )
        while (events.length() > 500) events.remove(0)

        prefs.edit()
            .putString("ledger", ledger.toString())
            .putString("events", events.toString())
            .putBoolean(key, true)
            .apply()

        CopilotState.setPlate(c, sale.plate, "SOLD", sale.payout)
        CopilotState.savePlateAuction(c, sale.plate, "SOLD", finalPrice = sale.payout, fees = sale.commission)
        return true
    }
}
