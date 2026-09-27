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
            return now("ЗАФИКСИРОВАТЬ ПРОДАЖУ НОМЕРА", "Номер продан с аукциона", "${plateSale.plate}: выплата ${plateSale.payout} ₽; комиссия ${plateSale.commission} ₽${plateSale.commissionPercent?.let { " (${it}%)" } ?: ""}. Номер учитывается отдельно от автомобиля.", 98)
        }

        val base = OpportunityAnalyzer.analyze(c, text, v, balance, garage)
        val f = CopilotState.dealForecast(c, v)
        val expectedSale = if (f.has("sale_price") && !f.isNull("sale_price")) f.optLong("sale_price") else null
        val purchase = if (f.has("purchase") && !f.isNull("purchase")) f.optLong("purchase") else (v.price ?: 0L)
        val fees = if (f.has("fees") && !f.isNull("fees")) f.optLong("fees") else 0L
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
            val actionGain = if (best.expectedDelta != null && best.cost != null) best.expectedDelta - best.cost else Long.MIN_VALUE
            val saleIsBetter = profit > 0 && (best.action == "НИЧЕГО НЕ ДЕЛАТЬ" || actionGain == Long.MIN_VALUE || profit >= actionGain)
            if (saleIsBetter) {
                return now("ПРОДАВАТЬ", "Продажа сейчас выгоднее дальнейших вложений", "Ожидаемая цена ${expectedSale ?: 0} ₽; покупка/себестоимость $purchase ₽; комиссии $fees ₽; ожидаемая чистая прибыль +$profit ₽; ROI ${String.format("%.1f", roi)}%. Альтернатива '${best.action}' даёт меньший расчётный прирост.", 92)
            }
            val actionIsKnown = best.action != "НИЧЕГО НЕ ДЕЛАТЬ" && best.roi != null && best.cost != null && best.expectedDelta != null
            if (actionIsKnown && best.roi!! > 0.0 && best.confidence >= 55) {
                return now(best.action, "Сравнил действия и продажу", "Стоимость ${best.cost} ₽; ожидаемый прирост ${best.expectedDelta} ₽; дополнительный результат ${best.expectedDelta!! - best.cost!!} ₽; ROI ${String.format("%.1f", best.roi)}%; уверенность ${best.confidence}%. ${best.reason} Продажа сейчас: +$profit ₽.", best.confidence)
            }
        }

        if (profit > 0) return now("ПРОДАВАТЬ", "Есть положительный прогноз сделки", "Ожидаемая цена ${expectedSale ?: 0} ₽; ожидаемая прибыль +$profit ₽; ROI ${String.format("%.1f", roi)}%.", 80)
        if (base.action != "НАБЛЮДАЮ") return now(base.action, "$screen • ${base.title}", base.reason, base.confidence)
        return if (v.name.isNotBlank()) now("ПРОВЕРЯТЬ", "$screen • недостаточно данных для действия", "Copilot сравнивает покупку, продажу, ремонт, улучшения, задания, аукционы и бонусы; пока нет достаточных данных для расчёта следующего шага.", 55)
        else now("ЖДАТЬ", "Игра ещё не распознана", "Ожидаю стабильный кадр с данными игры.", 45)
    }
}