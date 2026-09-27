package com.carflip.copilot

object NewsParser {
    data class Promo(val code: String, val limited: Boolean)

    private val promoRegex = Regex("(?i)(?:/promo|промокод)\\s+([A-Z0-9_-]{2,32})")

    fun promo(text: String): Promo? {
        val match = promoRegex.find(text) ?: return null
        val code = match.groupValues[1].uppercase()
        val window = text.substring(maxOf(0, match.range.first - 180), minOf(text.length, match.range.last + 220)).lowercase()
        val limited = window.contains("огранич") || window.contains("лимит") || window.contains("limited")
        return Promo(code, limited)
    }

    fun isNews(text: String): Boolean {
        val s = text.lowercase()
        return s.contains("новости игры") || s.contains("новости") || s.contains("news") || promo(text) != null
    }

    fun summary(text: String): String? {
        val promo = promo(text)
        if (promo != null) return "ПРОМОКОД • ${promo.code}${if (promo.limited) " • активации ограничены" else ""}"
        if (!isNews(text)) return null
        val lines = text.lines().map { it.trim() }.filter { it.length >= 8 }
        return lines.firstOrNull { !it.contains("новости", true) && !it.contains("news", true) }
            ?.take(220)
    }

    fun recommendedAction(text: String): String? {
        val promo = promo(text)
        if (promo != null) return "АКТИВИРОВАТЬ /promo ${promo.code}"
        return if (isNews(text)) "ПРОЧИТАТЬ НОВОСТЬ" else null
    }
}
