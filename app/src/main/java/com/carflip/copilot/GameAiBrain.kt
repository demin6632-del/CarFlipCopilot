package com.carflip.copilot

import android.content.Context

/**
 * Единый игровой мозг CarFlipCopilot.
 * Решает по текущему экрану, накопленной истории и экономике игры.
 */
object GameAiBrain {
    data class BrainResult(val opportunity: Opportunity, val urgent: Boolean = false)
    private data class ContractRule(
        val name: String,
        val usa: Boolean,
        val minHp: Int?,
        val maxPainted: Int?,
        val maxPrice: Long?,
        val bonus: Long
    )

    private fun result(action: String, title: String, reason: String, confidence: Int, urgent: Boolean = false) =
        BrainResult(Opportunity(action, title, reason, confidence), urgent)

    fun decide(context: Context, text: String, vehicle: VehicleSnapshot, balance: Long?, garage: Int): BrainResult {
        val money = balance ?: CopilotState.balance(context)
        val screen = GameScreenClassifier.classify(text)
        val lower = text.lowercase()

        val promo = NewsParser.promo(text)
        if (promo != null) {
            val extra = if (promo.limited) " • активации ограничены" else ""
            return result("АКТИВИРОВАТЬ /promo " + promo.code, "Промокод найден", promo.code + extra, 99, true)
        }

        val plateSale = GameParser.plateSaleEvent(text)
        if (plateSale != null) {
            return result("ЗАФИКСИРОВАТЬ", "Продажа номера",
                plateSale.plate + ": выплата " + plateSale.payout + " ₽, комиссия " + plateSale.commission + " ₽.", 99, true)
        }

        if (GameParser.plateAuctionNoBids(text)) {
            return result("НЕ СТАВИТЬ", "Номер возвращается на склад",
                "Аукцион номера завершился без ставок. Деньги не тратим.", 97, true)
        }

        val reward = GameParser.rewardAmount(text)
        if (reward != null || screen == "НАГРАДА" || lower.contains("забери награду")) {
            val amount = if (reward != null) " на " + reward + " ₽" else ""
            return result("ПОЛУЧИ", "Есть награда", "Найдено игровое вознаграждение" + amount + ".", 96, true)
        }

        if (lower.contains("ошибка") || lower.contains("error") || lower.contains("недоступно")) {
            return result("ЖДАТЬ", "Ошибка игрового экрана", "Не принимаю экономическое решение по ошибочному состоянию.", 94, true)
        }

        if (screen == "АУКЦИОН_НОМЕРОВ" || GameParser.plateAuction(text)) {
            return plateDecision(context, text, vehicle)
        }

        if (screen == "УЛИЧНЫЕ_ГОНКИ" || screen == "ПАРЫ_С_КОНКУРЕНТАМИ" || screen == "СОРЕВНОВАНИЕ") {
            return competitionDecision(text)
        }

        if (screen == "ИМПОРТ_ТАМОЖНЯ") {
            return importDecision(text)
        }

        if (screen == "ФИНАНСОВЫЙ_СЕКТОР" || screen == "ФИНАНСЫ" || screen == "БИЗНЕСЫ" || screen == "РАБОТА") {
            return financeDecision(text, money, screen)
        }

        if (screen == "ПРОДАЖА" || lower.contains("предложение покупателя")) {
            return saleDecision(context, text, vehicle)
        }

        if (screen == "УЛУЧШЕНИЕ" || GameParser.action(text) != null) {
            return upgradeDecision(context, text, vehicle)
        }

        val contract = parseContract(text)
        if (contract != null || screen == "КОНТРАКТ_ЗАДАНИЕ") {
            if (hasVehicle(vehicle)) return vehicleDecision(context, vehicle, money, garage, contract)
            return result("СРАВНИ", "Контракт/задание",
                "Сначала проверяю требования, награду, расходы и лимит капитала.", 90)
        }

        if (hasVehicle(vehicle) || screen == "АВТО" || screen == "ПОКУПКА") {
            return vehicleDecision(context, vehicle, money, garage, contract)
        }

        if (screen == "ГАРАЖ") {
            return if (garage >= 3) {
                result("ОСВОБОДИ ГАРАЖ", "Гараж заполнен",
                    "Сейчас " + garage + "/3. Перед новой покупкой закрой слабую сделку.", 93)
            } else {
                result("ОБЗОР", "Гараж", "Проверяю открытые сделки, номера и свободный капитал.", 80)
            }
        }

        if (screen == "РЫНОК_АВТО" || screen == "АВТОСАЛОН") {
            return result("ИЩИ ВЫГОДУ", "Рынок открыт",
                "Жду карточки машин и сравниваю цену входа, спрос и обязательные расходы.", 84)
        }

        return result("НАБЛЮДАЙ", "Игра сканируется",
            "Слежу за машинами, покупателями, номерами, аукционами, контрактами, расходами, наградами и соревнованиями.", 72)
    }

    private fun hasVehicle(v: VehicleSnapshot) =
        v.name.isNotBlank() || v.price != null || v.hp != null || v.plate.isNotBlank()

    private fun parseContract(text: String): ContractRule? {
        val s = text.lowercase()
        if (s.contains("кинопродюсер")) {
            return ContractRule("Кинопродюсер", true, 300, 99, 2500000L, 200000L)
        }
        val line = GameParser.contract(text) ?: return null
        val usa = s.contains("сша") || s.contains("usa") || s.contains("америк")
        val hp = Regex("(?:от|>=|минимум)[^0-9]{0,12}([0-9]{2,4})").find(line)?.groupValues?.getOrNull(1)?.toIntOrNull()
        val maxPrice = Regex("(?:до|не более|лимит)[^0-9]{0,20}([0-9][0-9\\s.,]*)").find(line)
            ?.groupValues?.getOrNull(1)?.replace(Regex("[^0-9]"), "")?.toLongOrNull()
        val paint = Regex("(?:до|не более|макс)[^0-9]{0,12}([0-9]{1,3})").find(line)?.groupValues?.getOrNull(1)?.toIntOrNull()
        val bonus = GameParser.rewardAmount(text) ?: 0L
        return ContractRule(line.take(60), usa, hp, paint, maxPrice, bonus)
    }

    private fun vehicleDecision(context: Context, v: VehicleSnapshot, money: Long, garage: Int, rule: ContractRule?): BrainResult {
        if (garage >= 3) return result("ОСВОБОДИ ГАРАЖ", "Гараж заполнен", "Новая машина займёт последний слот.", 97)
        val price = v.price
        if (price != null && price > money) return result("НЕ ПОКУПАЙ", "Не хватает денег",
            "Цена " + price + " ₽ выше баланса " + money + " ₽.", 99)

        if (rule != null) {
            if (rule.maxPrice != null && price != null && price > rule.maxPrice)
                return result("НЕ ПОКУПАЙ", "Не проходит контракт", "Цена выше лимита контракта.", 99)
            if (rule.minHp != null && v.hp != null && v.hp < rule.minHp)
                return result("НЕ ПОКУПАЙ", "Не проходит контракт", v.hp.toString() + " л.с. меньше требования " + rule.minHp + ".", 99)
            if (rule.maxPainted != null && v.paintedParts != null && v.paintedParts > rule.maxPainted)
                return result("НЕ ПОКУПАЙ", "Слишком много окраса", v.paintedParts.toString() + " деталей выше лимита.", 99)
            if (rule.usa && v.origin.isNotBlank() && v.origin != "USA")
                return result("НЕ ПОКУПАЙ", "Не проходит происхождение", "Контракт требует USA/США.", 99)
        }

        val forecast = CopilotState.dealForecast(context, v)
        val sale = forecast.optLong("sale_price", 0L)
        val profit = if (forecast.has("expected_profit") && !forecast.isNull("expected_profit"))
            forecast.optLong("expected_profit") else null

        if (rule != null && rule.bonus > 0L && price != null && rule.maxPrice != null &&
            price <= rule.maxPrice && (!rule.usa || v.origin == "USA") &&
            (rule.minHp == null || (v.hp ?: 0) >= rule.minHp) &&
            (rule.maxPainted == null || (v.paintedParts ?: 0) <= rule.maxPainted)) {
            if (profit != null && profit > 0L) {
                return result("ПОКУПАЙ", "Машина подходит под контракт",
                    "Цена " + price + " ₽; бонус +" + rule.bonus + " ₽; прогноз выхода " + sale + " ₽; чистая прибыль +" + profit + " ₽.", 96, true)
            }
            if (v.origin == "USA" && (v.hp ?: 0) >= 300 && v.paintedParts != null && v.paintedParts <= 99) {
                return result("ПРОВЕРЬ И ПОКУПАЙ", "Кандидат под контракт",
                    "Цена проходит лимит; USA; " + v.hp + " л.с.; окрас " + v.paintedParts + "; бонус +" + rule.bonus + " ₽. Сначала проверка.", 91, true)
            }
        }

        if (profit != null && profit > 0L && price != null) {
            return result("ПОКУПАЙ", "Есть положительная экономика",
                "Цена " + price + " ₽; прогноз выхода " + sale + " ₽; чистая прибыль +" + profit + " ₽.", 90, true)
        }

        val known = LearningMemory.estimatedSale(context, v, null)
        if (known != null && price != null && known > price) {
            return result("ПОКУПАЙ", "Есть история спроса",
                "Сохранённые предложения дают ориентир " + known + " ₽ против цены " + price + " ₽.", 87)
        }

        if (price != null) {
            return result("ПРОВЕРЬ", "Недостаточно данных для покупки",
                "Цена известна, но нет надёжной цены выхода. Сначала проверяю спрос и расходы.", 84)
        }

        return result("СОБИРАЙ ДАННЫЕ", "Карточка неполная",
            "Нужны цена, мощность, происхождение, пробег, владельцы, окрас и номер.", 92)
    }

    private fun saleDecision(context: Context, text: String, v: VehicleSnapshot): BrainResult {
        val direct = GameParser.saleAmount(text)
        if (direct != null && direct > 0L)
            return result("ЗАФИКСИРОВАТЬ", "Продажа совершена", "Выплата " + direct + " ₽ сохранена для обучения.", 99, true)

        val f = CopilotState.dealForecast(context, v)
        val profit = if (f.has("expected_profit") && !f.isNull("expected_profit")) f.optLong("expected_profit") else null
        if (profit != null && profit > 0L)
            return result("ПРОДАВАЙ", "Прогноз положительный", "Ожидаемая чистая прибыль +" + profit + " ₽. Сверяю фактическое предложение.", 90)

        return result("СРАВНИ ПРЕДЛОЖЕНИЯ", "Идёт продажа",
            "Запоминаю суммы и причины торга покупателей и выбираю лучший выход.", 88)
    }

    private fun plateDecision(context: Context, text: String, v: VehicleSnapshot): BrainResult {
        val plate = if (v.plate.isNotBlank()) v.plate else GameParser.plate(text)
        if (plate.isBlank()) return result("НАЙДИ НОМЕР", "Номер не распознан",
            "Без номера нельзя связать ставку, себестоимость и итог аукциона.", 90)

        val auction = CopilotState.plateAuction(context, plate)
        val bid = CopilotState.plateBestBid(context, plate) ?: GameParser.bidAmount(text)
        val cost = CopilotState.plateCost(context, plate)
        val fees = auction.optLong("fees", 0L)

        if (bid != null && cost != null && cost > 0L) {
            val net = bid - cost - fees
            val roi = net.toDouble() / cost.toDouble() * 100.0
            if (net < 0L) return result("НЕ ПОВЫШАЙ", "Номер уходит в минус",
                "Чистый результат " + net + " ₽; ROI " + String.format("%.1f", roi) + "%.", 98)
            return result("ЖДАТЬ", "Номер пока прибыльный",
                "Чистый результат " + net + " ₽; ROI " + String.format("%.1f", roi) + "%. Не повышай без нового обоснования.", 92)
        }

        return result("СОБИРАЙ ДАННЫЕ", "Аукцион номера",
            "Связываю номер с себестоимостью, ставкой, комиссией и финальной выплатой.", 86)
    }

    private fun upgradeDecision(context: Context, text: String, v: VehicleSnapshot): BrainResult {
        val action = GameParser.action(text) ?: return result("НЕ ТРАТЬ", "Расход не распознан",
            "Не трачу деньги, пока не вижу услугу и стоимость.", 92)
        val learned = ActionRoiEngine.learned(context, v, action)
        if (learned.realizedRoi != null) {
            return if (learned.realizedRoi > 0.0)
                result("РАССМОТРИ " + action, "Улучшение имеет историю",
                    "Реализованный ROI " + String.format("%.1f", learned.realizedRoi) + "% по " + learned.realizedSamples + " наблюдениям.", learned.confidence)
            else
                result("НЕ ТРАТЬ", "Улучшение раньше не окупалось",
                    "Реализованный ROI " + String.format("%.1f", learned.realizedRoi) + "%.", learned.confidence)
        }
        return result("НЕ ТРАТЬ", "Нет подтверждённого ROI",
            "Сначала накопим фактические результаты по этому типу машины.", 78)
    }

    private fun competitionDecision(text: String): BrainResult {
        val cost = GameParser.expenseAmount(text)
        val reward = GameParser.rewardAmount(text)
        if (cost != null && reward != null) {
            return if (reward > cost)
                result("УЧАСТВУЙ", "Награда выше входа",
                    "Вход " + cost + " ₽; награда " + reward + " ₽. Есть видимый запас.", 86)
            else
                result("НЕ УЧАСТВУЙ", "Вход дороже награды",
                    "Вход " + cost + " ₽ против награды " + reward + " ₽.", 92)
        }
        return result("ПРОВЕРЬ УСЛОВИЯ", "Соревнование/дуэль",
            "Нужны входная стоимость, награда и условия победы.", 82)
    }

    private fun importDecision(text: String): BrainResult {
        val cost = GameParser.expenseAmount(text)
        val reward = GameParser.rewardAmount(text)
        if (cost != null && reward != null) {
            return if (reward > cost)
                result("РАССМОТРИ", "Импорт имеет запас",
                    "Затраты " + cost + " ₽; видимая ценность " + reward + " ₽. Нужны риски.", 78)
            else
                result("НЕ БЕРИ РИСК", "Импорт не покрывает вход",
                    "Затраты " + cost + " ₽ против ценности " + reward + " ₽.", 90)
        }
        return result("СРАВНИ", "Импорт/таможня",
            "Сравниваю вход, таможенные расходы, цену выхода и резерв денег.", 80)
    }

    private fun financeDecision(text: String, money: Long, screen: String): BrainResult {
        val cost = GameParser.expenseAmount(text)
        val reward = GameParser.rewardAmount(text)
        if (cost != null && reward != null) {
            return if (reward > cost)
                result("РАССМОТРИ", screen + " • положительная разница",
                    "Доход " + reward + " ₽ выше расхода " + cost + " ₽.", 84)
            else
                result("НЕ ТРАТЬ", screen + " • отрицательная разница",
                    "Расход " + cost + " ₽ выше дохода " + reward + " ₽.", 92)
        }
        if (money < 250000L)
            return result("КОПИ НАЛИЧНЫЕ", "Маленький резерв",
                "Баланс " + money + " ₽. Сохраняю ликвидность до подтверждённой сделки.", 90)
        return result("КОНТРОЛИРУЙ", screen + " • экономика",
            "Не блокируй весь баланс одной операцией. Слежу за расходами и окупаемостью.", 80)
    }
}
