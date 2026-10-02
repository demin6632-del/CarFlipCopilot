package com.carflip.copilot

import android.os.SystemClock

/**
 * OCR on a live game screen is rarely byte-for-byte identical from frame to frame.
 * Accept exact repeats quickly, but also periodically accept changed screens so
 * dynamic events (auctions, offers, sales, rewards, races, etc.) are not missed.
 */
class StableOcr {
    private var lastNormalized = ""
    private var repeatCount = 0
    private var stableText = ""
    private var lastAcceptedAt = 0L

    fun accept(text: String): String? {
        val normalized = text.lowercase()
            .replace(Regex("\\s+"), " ")
            .trim()
        if (normalized.isBlank()) return null

        val now = SystemClock.elapsedRealtime()
        if (normalized == lastNormalized) {
            repeatCount++
        } else {
            lastNormalized = normalized
            repeatCount = 1
        }

        if (repeatCount >= 2 && normalized != stableText) {
            stableText = normalized
            lastAcceptedAt = now
            return text
        }

        // Changed screens are accepted faster so the live assistant reacts promptly.
        if (normalized != stableText && now - lastAcceptedAt >= 700L) {
            stableText = normalized
            lastAcceptedAt = now
            return text
        }

        return null
    }

    fun reset() {
        lastNormalized = ""
        repeatCount = 0
        stableText = ""
        lastAcceptedAt = 0L
    }
}
