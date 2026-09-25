package com.carflip.copilot

import android.os.SystemClock

class StableOcr {
    private var lastSignature = ""
    private var repeatCount = 0
    private var stableText = ""
    private var lastAcceptedAt = 0L

    fun accept(text: String): String? {
        val normalized = text.lowercase()
            .replace(Regex("\s+"), " ")
            .trim()
        if (normalized.isBlank()) return null
        val signature = normalized.hashCode().toString()
        if (signature == lastSignature) {
            repeatCount++
        } else {
            lastSignature = signature
            repeatCount = 1
        }
        if (repeatCount >= 2 || SystemClock.elapsedRealtime() - lastAcceptedAt > 5000) {
            if (normalized != stableText) {
                stableText = normalized
                lastAcceptedAt = SystemClock.elapsedRealtime()
                return text
            }
        }
        return null
    }

    fun reset() {
        lastSignature = ""
        repeatCount = 0
        stableText = ""
        lastAcceptedAt = 0L
    }
}
