package com.carflip.copilot

/**
 * Compares two explicit plate exit strategies.
 *
 * The game charges 55,000 ₽ to remove a plate. We only declare the
 * separate-sale strategy better when the expected car-without-plate
 * price and the actual/expected plate payout are both known.
 */
data class PlateExitComparison(
    val withPlateTotal: Long,
    val separateTotal: Long,
    val difference: Long
) {
    val separateIsBetter: Boolean get() = difference > 0
}

object PlateDecisionEngine {
    const val PLATE_REMOVAL_COST = 55_000L

    fun compare(
        carWithPlateSale: Long?,
        carWithoutPlateSale: Long?,
        platePayout: Long?
    ): PlateExitComparison? {
        if (carWithPlateSale == null || carWithoutPlateSale == null || platePayout == null) return null
        if (carWithPlateSale <= 0 || carWithoutPlateSale <= 0 || platePayout <= 0) return null
        val separate = carWithoutPlateSale + platePayout - PLATE_REMOVAL_COST
        return PlateExitComparison(carWithPlateSale, separate, separate - carWithPlateSale)
    }

    fun summary(c: PlateExitComparison): String {
        val sign = if (c.difference >= 0) "+" else ""
        return "С номером: " + c.withPlateTotal + " ₽; отдельно: " + c.separateTotal + " ₽; разница: " + sign + c.difference + " ₽."
    }
}
