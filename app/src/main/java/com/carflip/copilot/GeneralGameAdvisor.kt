package com.carflip.copilot

/**
 * Entry point for game-level guidance.
 * Vehicle and plate analysis remains in OpportunityAnalyzer.
 */
object GeneralGameAdvisor {
    fun analyze(context: android.content.Context, text: String, balance: Long?, garage: Int?): Opportunity? {
        val top = GameOpportunityPlanner.plan(text, balance, garage).firstOrNull() ?: return null
        return Opportunity(
            top.action,
            top.title,
            top.reason,
            top.confidence
        )
    }
}
