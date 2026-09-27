package com.carflip.copilot

import android.content.Context

object DecisionEngine {
    private fun now(action: String, situation: String, details: String, confidence: Int): Opportunity {
        val cleanAction = action.trim().uppercase().ifBlank { "НАБЛЮДАЙ" }
        val cleanSituation = situation.replace(Regex("\\s+"), " ").trim().take(72)
        val cleanDetails = details.replace(Regex("\\s+"), " ").trim()
        return Opportunity("СЕЙЧАС: $cleanAction", cleanSituation.ifBlank { "Текущая игровая ситуация" }, cleanDetails, confidence)
    }

    fun decide(c: Context, text: String, v: VehicleSnapshot, balance: Long?, garage: Int?): Opportunity {
        val screen = GameScreenClassifier.classify(text)
        WholeGameEventEngine.observe(c, text, screen, v)
        val plateSale = GameParser.plateSaleEvent(text)
        if (plateSale != null) {
            PlateSaleRecorder.record(c, plateSale)
            return now("ЗАФИКСИРОВАТЬ ПРОДАЖУ", "Номер продан с аукциона", "${plateSale.plate}: выплата ${plateSale.payout} ₽; комиссия ${plateSale.commission} ₽${plateSale.commissionPercent?.let { " (${it}%)" } ?: ""}. Номер учитывается отдельно от автомобиля.", 98)
        }

        val base = OpportunityAnalyzer.analyze(c, text, v, balance, garage)
        val f = CopilotState.dealForecast(c, v)
        val profit = if (f.has("expected_profit") && !f.isNull("expected_profit")) f.optLong("expected_profit") else 0L
        val roi = if (f.has("roi_percent") && !f.isNull("roi_percent")) f.optDouble("roi_percent") else 0.0

        if (v.plate.isNotBlank()) {
            val a = CopilotState.plateAuction(c, v.plate)
            val bid = CopilotState.plateBestBid(c, v.plate)
            val cost = CopilotState.plateCost(c, v.plate)
            val status = a.optString("status", "")
            if (status == "SOLD") return now("ЗАФИКСИРОВАТЬ", "Аукцион номера завершён", "Номер уже продан отдельно от автомобиля.", 96)
            if ((status == "OPEN" || status == "LIVE" || GameParser.plateAuction(text)) && bid != null && cost != null && cost > 0) {
                val net = bid - cost - a.optLong("fees")
                val r = net.toDouble() / cost * 100
                if (r < 0) return now("НЕ ПОВЫШАТЬ СТАВКУ", "Аукцион номера сейчас убыточен", "Текущая ставка $bid ₽; чистый результат $net ₽; ROI ${String.format("%.1f", r)}%.", 93)
                return now("ЖДАТЬ", "Идут торги за номер", "Текущая ставка $bid ₽; чистый результат $net ₽; ROI ${String.format("%.1f", r)}%.", 86)
            }
        }

        val hasCar = v.name.isNotBlank() || v.price != null || v.hp != null || v.plate.isNotBlank()
        if (hasCar) {
            val best = ActionDecisionEngine.best(c, v)
            val bestRoi = best.roi
            val bestCost = best.cost
            val bestDelta = best.expectedDelta
            val actionIsKnown = best.action != "НИЧЕГО НЕ ДЕЛАТЬ" && bestRoi != null && bestCost != null && bestDelta != null
            if (actionIsKnown && bestRoi!! > 0.0 && best.confidence >= 55) {
                val saleDetails = if (profit > 0) " Продажа сейчас даёт прогноз +$profit ₽." else ""
                return now(
                    best.action,
                    "Сравнил доступные действия по этой машине",
                    "Стоимость ${bestCost} ₽; ожидаемый прирост ${bestDelta} ₽; ROI ${String.format("%.1f", bestRoi)}%; уверенность ${best.confidence}%. ${best.reason}$saleDetails",
                    best.confidence
                )
            }
        }

        if (profit > 0) return now("ПРОДАВАТЬ", "Есть положительный прогноз сделки", "Ожидаемая прибыль: $profit ₽; ROI ${String.format("%.1f", roi)}%.", 80)
        if (base.action != "НАБЛЮДАЮ") return now(base.action, "$screen • ${base.title}", base.reason, base.confidence)
        return if (v.name.isNotBlank()) now("ПРОВЕРЯТЬ", "$screen • недостаточно данных для действия", "Copilot сравнивает покупку, продажу, ремонт и улучшения; пока нет достаточных данных для безопасного расчёта.", 55)
        else now("ЖДАТЬ", "Игра ещё не распознана", "Ожидаю стабильный кадр с данными игры.", 45)
    }
}
