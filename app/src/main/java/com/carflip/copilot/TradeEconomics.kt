package com.carflip.copilot

/**
 * Deterministic trade math for the current CarFlipCopilot game rules.
 * Missing market exit price stays unknown; we never invent a sale price.
 */
data class ContractRules(
    val name: String = "Кинопродюсер",
    val origin: String = "USA",
    val minHp: Int = 300,
    val maxPaintedParts: Int = 99,
    val maxCarPrice: Long = 2_500_000L,
    val bonus: Long = 200_000L
)

data class TradeCosts(
    val thicknessGauge: Long = 3_000L,
    val autotekа: Long = 5_000L,
    val listingExtension: Long = 1_500L,
    val plateRemoval: Long = 55_000L
) {
    val mandatoryChecks: Long get() = thicknessGauge + autotekа
}

data class TradeEconomics(
    val purchasePrice: Long?,
    val checks: Long,
    val otherFees: Long,
    val contractBonus: Long,
    val expectedSalePrice: Long?,
    val netCost: Long?,
    val expectedProfit: Long?,
    val contractEligible: Boolean,
    val missing: List<String>
)

object TradeEconomics {
    val contract = ContractRules()
    val costs = TradeCosts()

    fun calculate(
        vehicle: VehicleSnapshot,
        expectedSalePrice: Long? = null,
        includeContractBonus: Boolean = true,
        extraFees: Long = 0L
    ): TradeEconomics {
        val missing = mutableListOf<String>()
        if (vehicle.price == null) missing += "цена покупки"
        if (vehicle.hp == null) missing += "мощность"
        if (vehicle.origin.isBlank()) missing += "происхождение USA"
        if (vehicle.paintedParts == null) missing += "крашеные детали"
        if (expectedSalePrice == null) missing += "цена выхода"

        val eligible = vehicle.price != null &&
            vehicle.hp != null && vehicle.origin == contract.origin &&
            vehicle.paintedParts != null && vehicle.paintedParts <= contract.maxPaintedParts &&
            vehicle.hp >= contract.minHp && vehicle.price <= contract.maxCarPrice

        val purchase = vehicle.price
        val checks = if (purchase != null) costs.mandatoryChecks else 0L
        val netCost = purchase?.plus(checks)?.plus(extraFees)
        val bonus = if (eligible && includeContractBonus) contract.bonus else 0L
        val profit = if (expectedSalePrice != null && netCost != null) {
            expectedSalePrice - netCost + bonus
        } else null

        return TradeEconomics(
            purchasePrice = purchase,
            checks = checks,
            otherFees = extraFees,
            contractBonus = bonus,
            expectedSalePrice = expectedSalePrice,
            netCost = netCost,
            expectedProfit = profit,
            contractEligible = eligible,
            missing = missing
        )
    }

    fun summary(e: TradeEconomics): String {
        val lines = mutableListOf<String>()
        e.purchasePrice?.let { lines += "Цена входа: ${money(it)} ₽" }
        lines += "Проверки: -${money(e.checks)} ₽"
        e.netCost?.let { lines += "Себестоимость: ${money(it)} ₽" }
        lines += "Контракт: ${if (e.contractEligible) "ПОДХОДИТ" else "НЕ ПОДТВЕРЖДЁН"}"
        if (e.contractBonus > 0) lines += "Бонус: +${money(e.contractBonus)} ₽"
        e.expectedProfit?.let {
            lines += "Ожидаемый результат: ${if (it >= 0) "+" else ""}${money(it)} ₽"
        }
        if (e.missing.isNotEmpty()) lines += "Не хватает: ${e.missing.joinToString(", ")}" 
        return lines.joinToString("\n")
    }

    fun money(value: Long): String = "%,d".format(java.util.Locale.US, value).replace(',', ' ')
}
