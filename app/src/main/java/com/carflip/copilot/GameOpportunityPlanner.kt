package com.carflip.copilot

/**
 * Builds game-level opportunities from the current screen and known resources.
 * The planner deliberately uses only information already parsed by Copilot.
 */
object GameOpportunityPlanner {
    data class Candidate(
        val action: String,
        val title: String,
        val reason: String,
        val priority: Int,
        val confidence: Int
    )

    fun plan(text: String, balance: Long?, garage: Int?): List<Candidate> {
        val s = text.lowercase()
        val screen = GameParser.screenType(text)
        val resources = GameParser.resources(text)
        val out = mutableListOf<Candidate>()

        if (GameParser.rewardAmount(text) != null ||
            listOf("получи награду", "забери награду", "награда доступна", "бонус доступен")
                .any { s.contains(it) }) {
            out += Candidate(
                "ПОЛУЧИТЬ НАГРАДУ", "Есть доступная награда",
                "Сначала забери уже доступную награду. Это действие не требует новой покупки.",
                100, 96
            )
        }

        if (balance != null && balance <= 0L) {
            out += Candidate(
                "НЕ ТРАТИТЬ", "Нет свободного баланса",
                "Сначала восстанови деньги или получи награду. Новые расходы сейчас не подтверждены экономикой.",
                99, 99
            )
        }

        val garageFull = garage != null && garage >= 3
        if (garageFull &&
            (screen == "ПОКУПКА" || screen == "АУКЦИОН" || screen == "ГАРАЖ" ||
             s.contains("купить") || s.contains("покупка"))) {
            out += Candidate(
                "НЕ ПОКУПАТЬ СЕЙЧАС", "Гараж заполнен",
                "Перед новой покупкой сначала реши судьбу уже имеющихся машин и освободи место только если это выгодно.",
                97, 95
            )
        }

        if (screen == "ЗАДАНИЕ") {
            val contract = GameParser.contract(text)
            val title = if (contract != null) "Задание/контракт найдено" else "Доступна игровая цель"
            val reason = if (contract != null) {
                "Проверь требования, награду и неизбежные расходы по распознанному заданию: ${contract.take(180)}"
            } else {
                "Сверь требования, награду, срок и неизбежные расходы. Не покупай автомобиль только ради цели без расчёта."
            }
            out += Candidate("ПРОВЕРИТЬ ЗАДАНИЕ", title, reason, 94, 93)
        }

        if (screen == "СОРЕВНОВАНИЕ") {
            out += Candidate(
                "СРАВНИТЬ НАГРАДУ", "Доступно испытание",
                "Сравни входные затраты, риск потери ресурсов и награду до подтверждения участия.",
                91, 88
            )
        }

        if (screen == "МАГАЗИН") {
            out += Candidate(
                "СНАЧАЛА ПОСЧИТАТЬ", "Открыт магазин",
                "Сравни цену с балансом и ожидаемой пользой. Сам факт наличия товара не означает, что его нужно покупать.",
                88, 89
            )
        }

        if (screen == "ФИНАНСЫ") {
            out += Candidate(
                "КОНТРОЛИРОВАТЬ РАСХОДЫ", "Финансовый экран",
                "Учитывай покупки, комиссии, продления объявлений, ремонт, улучшения и фактические выплаты.",
                90, 91
            )
        }

        if (screen == "АУКЦИОН" || screen == "АУКЦИОН_НОМЕРА") {
            out += Candidate(
                "НЕ ПОВЫШАТЬ СРАЗУ", "Идут торги",
                "Перед новой ставкой проверь полную себестоимость, комиссию и ожидаемую выплату. При нехватке данных не повышай ставку.",
                92, 90
            )
        }

        if (listOf("купить", "покупка", "улучшить", "улучшение", "ремонт", "тюнинг", "оплатить", "ставка")
                .any { s.contains(it) }) {
            out += Candidate(
                "СНАЧАЛА ПОСЧИТАТЬ", "Предстоит расход",
                "Перед оплатой сравни стоимость действия с ожидаемой выгодой и учти его как реальный расход сделки, если он относится к машине.",
                86, 87
            )
        }

        val energy = resources["энергия"]
        if (energy != null && (
                s.contains("энергия восстановлена") ||
                s.contains("энергия полна") ||
                s.contains("energy restored") ||
                s.contains("energy full"))) {
            out += Candidate(
                "ИСПОЛЬЗОВАТЬ ЭНЕРГИЮ", "Энергия восстановлена",
                "Энергия уже восстановлена. Сначала проверь доступное действие, которое превращает её в деньги, опыт или прогресс.",
                84, 88
            )
        }

        if (listOf("работа доступна", "начать работу", "work available", "бонус доступен",
                   "новость", "контракт доступен", "заказ доступен")
                .any { s.contains(it) }) {
            out += Candidate(
                "ПРОВЕРИТЬ ВЫГОДУ", "Есть игровая возможность",
                "Copilot учитывает не только машины и номера: работу, задания, бонусы, ресурсы и расходы.",
                70, 78
            )
        }

        return out.sortedWith(compareByDescending<Candidate> { it.priority }.thenByDescending { it.confidence })
    }
}
