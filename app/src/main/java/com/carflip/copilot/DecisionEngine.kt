package com.carflip.copilot

import android.content.Context

/**
 * Стабилизирует решение поверх OCR, чтобы всплывающий помощник не мигал
 * между действиями из-за единичной ошибки распознавания.
 */
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
        val result = GameAiBrain.decide(c, text, v, balance, garage ?: CopilotState.garage(c))
        CopilotState.saveForecast(c, CopilotState.dealForecast(c, v).optLong("sale_price").takeIf { it > 0 },
            CopilotState.dealForecast(c, v).optLong("expected_profit").takeIf { CopilotState.dealForecast(c, v).has("expected_profit") },
            CopilotState.dealForecast(c, v).optDouble("roi_percent").takeIf { CopilotState.dealForecast(c, v).has("roi_percent") },
            result.opportunity.confidence)
        return stableDecision(result.opportunity, result.urgent)
    }
}
