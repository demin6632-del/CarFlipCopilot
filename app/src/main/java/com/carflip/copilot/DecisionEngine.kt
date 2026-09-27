package com.carflip.copilot

import android.content.Context

object DecisionEngine {
    private var stable: Opportunity? = null
    private var candidateKey = ""
    private var candidateCount = 0

    private fun stableDecision(next: Opportunity, urgent: Boolean): Opportunity {
        val key = next.action + "|" + next.title + "|" + next.reason.take(220)
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
        WholeGameEventEngine.observe(c, text, GameScreenClassifier.classify(text), v)
        val brain = GameAiBrain.decide(c, text, v, balance, garage ?: CopilotState.garage(c))
        val forecast = CopilotState.dealForecast(c, v)
        val sale = forecast.optLong("sale_price", 0L).takeIf { it > 0L }
        val profit = if (forecast.has("expected_profit") && !forecast.isNull("expected_profit")) {
            forecast.optLong("expected_profit")
        } else null
        val roi = if (forecast.has("roi_percent") && !forecast.isNull("roi_percent")) {
            forecast.optDouble("roi_percent")
        } else null
        CopilotState.saveForecast(c, sale, profit, roi, brain.opportunity.confidence)
        return stableDecision(brain.opportunity, brain.urgent)
    }
}
