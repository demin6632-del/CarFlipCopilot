package com.carflip.copilot

import android.content.Context

object DecisionEngine {
    private var stable: Opportunity? = null
    private var candidateKey = ""
    private var candidateCount = 0

    private fun now(action: String, situation: String, details: String, confidence: Int): Opportunity {
        val cleanAction = action.trim().uppercase().removePrefix("СЕЙЧАС:").trim().ifBlank { "НАБЛЮДАЙ" }
        val cleanSituation = situation.replace(Regex("\\s+"), " ").trim().take(96)
        val cleanDetails = details.replace(Regex("\\s+"), " ").trim()
        return Opportunity("СЕЙЧАС: $cleanAction", cleanSituation.ifBlank { "Текущая игровая ситуация" }, cleanDetails, confidence)
    }

    private fun stableDecision(next: Opportunity, urgent: Boolean = false): Opportunity {
        val key = "${next.action}|${next.title}|${next.details.take(180)}"
        if (urgent) {
            stable = next
            candidateKey = key
            candidateCount = 0
            return next
        }
        if (stable == null) {
            stable = next
            candidateKey = key
            return next
        }
        if (key == candidateKey) {
            candidateCount = 0
            return stable!!
        }
        candidateCount++
        if (candidateCount >= 2) {
            stable = next
            candidateKey = key
            candidateCount = 0
        }
        return stable!!
    }

    fun decide(c: Context, text: String, v: VehicleSnapshot, balance: Long?, garage: Int?): Opportunity {
        val screen = GameScreenClassifier.classify(text)
        WholeGameEventEngine.observe(c, text, screen, v)

        val promo = NewsParser.promo(text)
        if (promo != null) return stableDecision(now("АКТИВИРОВАТЬ /promo ${promo.code}", "Найден промокод", "Промокод ${promo.code}${if (promo.limited) " • количество активаций ограничено" else ""}.", 99), true)

        val news = NewsParser.summary(text)
        if (news != null && NewsParser.isNews(text)) return stableDecision(now("ПРОЧИТАТЬ НОВОСТЬ", "Новое событие игры", news, 94), true)

        val plateSale = GameParser.plateSaleEvent(text)
        if (plateSale != null) {
            PlateSaleRecorder.record(c, plateSale)
            return stableDecision(now("ЗАФИКСИРОВАТЬ ПРОДАЖУ НОМЕРА", "Номер продан с аукциона", "${plateSale.plate}: выплата ${plateSale.payout} ₽; комиссия ${plateSale.commission} ₽${plateSale.commissionPercent?.let { " (${it}%)" } ?: ""}.", 98), true)
        }

        val base = OpportunityAnalyzer.analyze(c, text, v, balance, garage)
        val f = CopilotState.dealForecast(c, v)
        val expectedSale = if (f.has("sale_price") && !f.isNull("sale_price")) f.optLong("sale_price") else null
        val purchase = if (f.has("purchase") && !f.isNull("purchase")) f.optLong("purchase") else (v.price ?: 0L)
        val fees = if (f.has("fees") && !f.isNull("fees")) f.optLong("fees") else 0L
        val profit = if (f.has("expected_profit") && !f.isNull("expected_profit")) f.optLong("expected_profit") else 0L
        val roi = if (f.has("roi_percent") && !f.isNull("roi_percent")) f.optDouble("roi_percent") else 0.0

        if (v.plate.isNotBlank()) {
            val carWithPlateSale = GameParser.saleAmount(text)
            val carWithoutPlateSale = GameParser.carWithoutPlateSale(text)
            val platePayout = GameParser.plateOffer(text) ?: CopilotState.plateBestBid(c, v.plate)
            val plateComparison = PlateDecisionEngine.compare(carWithPlateSale, carWithoutPlateSale, platePayout)
            if (plateComparison != null) {
                val action = if (plateComparison.separateIsBetter) "СНЯТЬ НОМЕР И ПРОДАТЬ ОТДЕЛЬНО" else "ПРОДАТЬ С НОМЕРОМ"
                val confidence = if (plateComparison.difference == 0L) 78 else 94
                return stableDecision(now(action, "Сравнил продажу автомобиля с номером и отдельно", PlateDecisionEngine.summary(plateComparison) + " Снятие номера: 55 000 ₽.", confidence), true)
            }
            val a = CopilotState.plateAuction(c, v.plate)
            val bid = CopilotState.plateBestBid(c, v.plate)
            val cost = CopilotState.plateCost(c, v.plate)
            val status = a.optString("status", "")
            if (status == "SOLD") return stableDecision(now("ЗАФИКСИРОВАТЬ", "Аукцион номера завершён", "Номер уже продан отдельно от автомобиля.", 96))
            if ((status == "OPEN" || status == "LIVE" || GameParser.plateAuction(text)) && bid != null && cost != null && cost > 0) {
                val net = bid - cost - a.optLong("fees")
                val r = net.toDouble() / cost * 100
                if (r < 0) return stableDecision(now("НЕ ПОВЫШАТЬ СТАВКУ", "Аукцион номера сейчас убыточен", "Текущая ставка $bid ₽; чистый результат $net ₽; ROI ${String.format("%.1f", r)}%.", 93))
                return stableDecision(now("ЖДАТЬ", "Идут торги за номер", "Текущая ставка $bid ₽; чистый результат $net ₽; ROI ${String.format("%.1f", r)}%.", 86))
            }
        }

        val hasCar = v.name.isNotBlank() || v.price != null || v.hp != null || v.plate.isNotBlank()
        if (hasCar) {
            val best = ActionDecisionEngine.best(c, v)
            val actionGain = if (best.expectedDelta != null && best.cost != null) best.expectedDelta - best.cost else Long.MIN_VALUE
            val saleIsBetter = profit > 0 && (best.action == "НИЧЕГО НЕ ДЕЛАТЬ" || actionGain == Long.MIN_VALUE || profit >= actionGain)
            if (saleIsBetter) return stableDecision(now("ПРОДАВАТЬ", "Продажа сейчас выгоднее дальнейших вложений", "Ожидаемая цена ${expectedSale ?: 0} ₽; себестоимость $purchase ₽; комиссии $fees ₽; ожидаемая чистая прибыль +$profit ₽; ROI ${String.format("%.1f", roi)}%.", 92))
            val actionIsKnown = best.action != "НИЧЕГО НЕ ДЕЛАТЬ" && best.roi != null && best.cost != null && best.expectedDelta != null
            if (actionIsKnown && best.roi!! > 0.0 && best.confidence >= 55) return stableDecision(now(best.action, "Сравнил действия и продажу", "Стоимость ${best.cost} ₽; ожидаемый прирост ${best.expectedDelta} ₽; дополнительный результат ${best.expectedDelta!! - best.cost!!} ₽; ROI ${String.format("%.1f", best.roi)}%; уверенность ${best.confidence}%. ${best.reason} Продажа сейчас: +$profit ₽.", best.confidence))
        }

        if (profit > 0) return stableDecision(now("ПРОДАВАТЬ", "Есть положительный прогноз сделки", "Ожидаемая цена ${expectedSale ?: 0} ₽; ожидаемая прибыль +$profit ₽; ROI ${String.format("%.1f", roi)}%.", 80))
        if (base.action != "НАБЛЮДАЮ") return stableDecision(now(base.action, "$screen • ${base.title}", base.reason, base.confidence))
        return stableDecision(if (v.name.isNotBlank()) now("ПРОВЕРЯТЬ", "$screen • недостаточно данных для действия", "Copilot сравнивает покупку, продажу, ремонт, улучшения, задания, аукционы, новости, бонусы и ресурсы; пока недостаточно данных для расчёта следующего шага.", 55) else now("ЖДАТЬ", "Игра ещё не распознана", "Ожидаю стабильный кадр с данными игры.", 45))
    }
}