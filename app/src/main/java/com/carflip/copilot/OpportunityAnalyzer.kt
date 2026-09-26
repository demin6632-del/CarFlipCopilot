package com.carflip.copilot

data class Opportunity(
    val action: String,
    val title: String,
    val reason: String,
    val confidence: Int = 0
)

object OpportunityAnalyzer {
    fun analyze(context: android.content.Context, text: String, v: VehicleSnapshot, balance: Long?, garage: Int?): Opportunity {
        val s = text.lowercase()
        val price = v.price
        val hp = v.hp
        val painted = v.paintedParts
        val hasCar = v.name.isNotBlank() || price != null || hp != null || v.plate.isNotBlank()
        val learned = if (hasCar) LearningMemory.score(context, v) else 0
        val economics = TradeEconomics.calculate(v)

        if (s.contains("награда") || s.contains("награду")) {
            return Opportunity("ПОЛУЧИ", "Есть награда", "Проверь условия и забери, если доступно.", 85)
        }
        if (s.contains("контракт") || s.contains("заказ")) {
            return Opportunity("ПРОВЕРЬ", "Новый контракт", "Сравню требования контракта с автомобилем и экономикой сделки.", 80)
        }
        if (s.contains("аукцион") || s.contains("ставк")) {
            if (v.plate.isNotBlank()) return Opportunity("АУКЦИОН", "Проверь номер", "Стартовая цена не считается фактической продажей номера.", 80)
            return Opportunity("ПРОВЕРЬ", "Аукцион", "Проверяю цену входа и возможную прибыль.", 70)
        }
        if (s.contains("продать") || s.contains("продаж") || s.contains("выставить")) {
            return Opportunity("ПРОДАВАЙ", "Есть возможность продажи", "Потенциальная прибыль считается только от фактического предложения/продажи.", 82)
        }
        if (s.contains("осмотр") || s.contains("автотека") || s.contains("толщиномер")) {
            return Opportunity("ПРОВЕРЬ", "Проверка автомобиля", "Проверки добавляют расходы и могут изменить решение о покупке.", 78)
        }
        if (hasCar) {
            if (price != null && balance != null && price > balance) {
                return Opportunity("НЕ ПОКУПАЙ", "Не хватает денег", "Цена выше доступного баланса.", 98)
            }
            if (garage != null && garage >= 3) {
                return Opportunity("НЕ ПОКУПАЙ", "Гараж заполнен", "Сначала освободи место или продай машину.", 98)
            }
            if (price != null && price > TradeEconomics.contract.maxCarPrice) {
                return Opportunity("НЕ ПОКУПАЙ", "Выше лимита контракта", "Цена превышает лимит 2 500 000 ₽ текущего контракта.", 99)
            }
            if (hp != null && hp < TradeEconomics.contract.minHp) {
                return Opportunity("НЕ ПОКУПАЙ", "Не подходит по мощности", "Текущий контракт требует минимум 300 л.с.", 99)
            }
            if (painted != null && painted > TradeEconomics.contract.maxPaintedParts) {
                return Opportunity("НЕ ПОКУПАЙ", "Слишком много окраса", "Текущий контракт допускает максимум 99 окрашенных деталей.", 99)
            }
            if (v.origin.isNotBlank() && v.origin != TradeEconomics.contract.origin) {
                return Opportunity("НЕ ПОКУПАЙ", "Не тот регион", "Текущий контракт требует автомобиль происхождения USA.", 97)
            }

            // A BUY signal is emitted only when every contract field is confirmed.
            // Missing origin/painted parts remain a CHECK, never a guessed approval.
            if (economics.contractEligible) {
                return Opportunity(
                    "ПОКУПАЙ",
                    "Кандидат под контракт",
                    "USA + минимум 300 л.с. + цена до 2,5 млн + подтверждённый окрас ≤99. " +
                        "Проверки: 8 000 ₽. Цена выхода пока неизвестна.",
                    (96 + learned).coerceIn(70, 99)
                )
            }
            if (price != null || hp != null || v.origin.isNotBlank() || painted != null) {
                val missing = economics.missing.filter { it != "цена выхода" }
                val detail = if (missing.isEmpty()) "Контрактные условия не подтверждены." else "Не хватает: ${missing.joinToString(", ")}."
                return Opportunity("ПРОВЕРЯЙ", "Недостаточно данных", "$detail Цена выхода не выдумывается.", (72 + learned).coerceIn(50, 95))
            }
        }
        return Opportunity("НАБЛЮДАЮ", "Ищу возможность", "Слежу за экраном и обновляю сигнал при изменении ситуации.", 40)
    }
}
