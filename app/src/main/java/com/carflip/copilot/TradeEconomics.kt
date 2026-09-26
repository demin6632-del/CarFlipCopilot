package com.carflip.copilot

data class ContractRules(
    val name: String,
    val origin: String,
    val minHp: Int,
    val maxPaintedParts: Int,
    val maxPurchasePrice: Long,
    val bonus: Long
)

data class TradeEconomics(
    val purchasePrice: Long?,
    val inspectionCosts: Long,
    val tuningCosts: Long,
    val preSaleCosts: Long,
    val listingExtensionCost: Long,
    val plateRemovalCost: Long,
    val totalKnownCosts: Long,
    val contractEligible: Boolean,
    val contractMissing: List<String>,
    val contractBonus: Long,
    val exitPrice: Long?,
    val expectedProfit: Long?
)

object TradeEconomics {
    const val THICKNESS_GAUGE = 3_000L
    const val AUTOTEKA = 5_000L
    const val POLISH_DETAILING = 7_416L
    const val LOCAL_PAINT = 5_932L
    const val ODOMETER_ROLLBACK = 30_000L
    const val LISTING_EXTENSION = 1_500L
    const val PLATE_REMOVAL = 55_000L

    val kinoProducer = ContractRules(
        name = "Кинопродюсер",
        origin = "USA",
        minHp = 300,
        maxPaintedParts = 99,
        maxPurchasePrice = 2_500_000L,
        bonus = 200_000L
    )

    fun calculate(v: VehicleSnapshot, exitPrice: Long? = null): TradeEconomics {
        val checks = THICKNESS_GAUGE + AUTOTEKA
        val preSale = if (v.polishApplied == true) POLISH_DETAILING else 0L
        val tuning = if (v.invested != null && v.price != null) {
            (v.invested - v.price - preSale).coerceAtLeast(0L)
        } else 0L

        val missing = mutableListOf<String>()
        if (v.origin.isBlank()) missing += "происхождение"
        if (v.hp == null) missing += "мощность"
        if (v.paintedParts == null) missing += "крашеные детали"
        if (v.price == null) missing += "цена входа"

        val eligible = missing.isEmpty() &&
            v.origin == kinoProducer.origin &&
            v.hp!! >= kinoProducer.minHp &&
            v.paintedParts!! <= kinoProducer.maxPaintedParts &&
            v.price!! <= kinoProducer.maxPurchasePrice

        val baseVehicleCost = maxOf(v.price ?: 0L, v.invested ?: 0L)
        val total = baseVehicleCost + checks + LISTING_EXTENSION
        val bonus = if (eligible) kinoProducer.bonus else 0L
        val profit = exitPrice?.let { it - totalWithPreSale + bonus }

        return TradeEconomics(
            purchasePrice = v.price,
            inspectionCosts = checks,
            tuningCosts = tuning,
            preSaleCosts = preSale,
            listingExtensionCost = LISTING_EXTENSION,
            plateRemovalCost = PLATE_REMOVAL,
            totalKnownCosts = total,
            contractEligible = eligible,
            contractMissing = missing,
            contractBonus = bonus,
            exitPrice = exitPrice,
            expectedProfit = profit
        )
    }

    fun summary(v: VehicleSnapshot, exitPrice: Long? = null): String {
        val e = calculate(v, exitPrice)
        val f = { n: Long -> "%,d".format(n).replace(',', ' ') }
        return buildString {
            append("Экономика сделки\n")
            append("Цена входа: ").append(e.purchasePrice?.let(f) ?: "—").append(" ₽\n")
            append("Проверки: ").append(f(e.inspectionCosts)).append(" ₽\n")
            append("Тюнинг/подготовка: ").append(f(e.tuningCosts + e.preSaleCosts)).append(" ₽\n")
            append("Себестоимость с размещением: ").append(f(e.totalKnownCosts)).append(" ₽\n")
            append("Контракт: ").append(if (e.contractEligible) "ПОДХОДИТ" else "НЕ ПОДТВЕРЖДЁН").append("\n")
            if (e.contractMissing.isNotEmpty()) append("Не хватает: ").append(e.contractMissing.joinToString(", ")).append("\n")
            append("Бонус: ").append(if (e.contractEligible) "+${f(e.contractBonus)}" else "—").append(" ₽\n")
            append("Выход: ").append(e.exitPrice?.let(f) ?: "—").append(" ₽\n")
            append("Прибыль: ").append(e.expectedProfit?.let { (if (it >= 0) "+" else "") + f(it) } ?: "неизвестна").append(" ₽")
        }
    }
}
