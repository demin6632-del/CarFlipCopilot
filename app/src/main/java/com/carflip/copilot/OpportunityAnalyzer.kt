package com.carflip.copilot

data class Opportunity(val action:String,val title:String,val reason:String,val confidence:Int=0)

object OpportunityAnalyzer {
    fun analyze(context: android.content.Context, text: String, v: VehicleSnapshot, balance: Long?, garage: Int?): Opportunity {
        val s = text.lowercase()
        val screen = GameParser.screenType(text)
        val event = GameParser.event(text)
        val reward = GameParser.rewardAmount(text)
        val bid = GameParser.bidAmount(text)
        val sale = GameParser.saleAmount(text)
        val price = v.price
        val hasCar = v.name.isNotBlank() || price != null || v.hp != null || v.plate.isNotBlank()
        val learned = if (hasCar) LearningMemory.score(context, v) else 0
\n        // Game-level guidance has priority: the assistant must advise on the whole game, not only cars and plates.\n        GeneralGameAdvisor.analyze(context, text, balance, garage)?.let { return it }\n
        if (reward != null || event == "НАГРАДА") {
            return Opportunity("ПОЛУЧИ", "Найдена награда", "Copilot видит награду/бонус${reward?.let { ": $it" } ?: ""}. Проверь условия и забери её, если действие не требует невыгодных затрат.", 90)
        }
        if (screen == "ЗАДАНИЕ") {
            return Opportunity("СРАВНИ", "Задание/контракт", "Сравни требования, награду, затраты и риск. Copilot отслеживает выполнение и итоговую прибыль.", 86)
        }
        if (screen == "СОРЕВНОВАНИЕ") {
            return Opportunity("АНАЛИЗИРУЙ", "Соревнование/испытание", "Сравни входную стоимость, потенциальную награду и требования. Не учитываю автомобильный аукцион как обычную продажу.", 82)
        }
        if (screen == "АУКЦИОН_НОМЕРА") {
            if (v.plate.isNotBlank()) {
                val a = CopilotState.plateAuction(context, v.plate)
                val current = CopilotState.plateBestBid(context, v.plate) ?: bid
                val cost = CopilotState.plateCost(context, v.plate)
                val fees = a.optLong("fees", 0)
                if (current != null && cost != null && cost > 0) {
                    val net = current - cost - fees
                    val roi = net.toDouble() / cost * 100.0
                    return if (roi < 0) Opportunity("НЕ ПОВЫШАЙ", "Номер уходит в минус", "Текущая ставка $current ₽; себестоимость $cost ₽; комиссия $fees ₽; расчётный ROI ${String.format("%.1f", roi)}%. Машина на этом аукционе не участвует.", 96)
                    else Opportunity("КОНТРОЛИРУЙ", "Аукцион номера", "Ставка $current ₽; чистый результат $net ₽; ROI ${String.format("%.1f", roi)}%. Copilot продолжит следить за изменением ставки.", 91)
                }
            }
            return Opportunity("СОБИРАЙ ДАННЫЕ", "Аукцион номера", "Отдельно считаю себестоимость, комиссию, текущую ставку и итоговую прибыль номера.", 84)
        }
        if (screen == "АУКЦИОН") {
            return Opportunity("АНАЛИЗИРУЙ", "Аукцион", "Copilot отслеживает ставки, комиссии и ожидаемый результат. Автомобиль и номер считаются раздельно.", 84)
        }
        if (screen == "ПРОДАЖА") {
            val forecast = CopilotState.dealForecast(context, v)
            val expected = if (forecast.has("expected_profit") && !forecast.isNull("expected_profit")) forecast.optLong("expected_profit") else 0L
            val expectedSale = if (forecast.has("sale_price") && !forecast.isNull("sale_price")) forecast.optLong("sale_price") else sale
            if (expected > 0) return Opportunity("ПРОДАВАЙ", "Положительный прогноз", "Ожидаемая цена продажи ${expectedSale ?: 0} ₽; ожидаемая прибыль $expected ₽.", 90)
            return Opportunity("ПРОВЕРЬ", "Проверка продажи", "Перед подтверждением продажи Copilot сверяет себестоимость, комиссии, предложения покупателей и ожидаемую прибыль.", 86)
        }
        if (screen == "УЛУЧШЕНИЕ") {
            val action = GameParser.action(text)
            return Opportunity("СЧИТАЙ ROI", action?.let { "Действие: $it" } ?: "Улучшение/расход", "Не оцениваю улучшение только по цене: Copilot сравнивает затраты с изменением ожидаемой цены продажи и учит фактический ROI.", 88)
        }
        if (screen == "ПРОВЕРКА") {
            return Opportunity("ПРОВЕРЬ", "Диагностика", "Результат проверки может изменить цену входа, расходы на ремонт и ожидаемую прибыль.", 87)
        }
        if (screen == "МАГАЗИН") {
            return Opportunity("СРАВНИ", "Покупка в магазине", "Сравниваю цену покупки с будущей ценностью/экономией и доступным балансом.", 80)
        }
        if (screen == "ФИНАНСЫ") {
            return Opportunity("КОНТРОЛИРУЙ", "Финансы", "Отслеживаю баланс, расходы, комиссии, вложения и прибыль, чтобы решения принимались по реальной экономике.", 88)
        }

        if (hasCar) {
            if (price != null && balance != null && price > balance) return Opportunity("НЕ ПОКУПАЙ", "Недостаточно денег", "Цена $price ₽ выше доступного баланса $balance ₽.", 98)
            if (garage != null && garage >= 3) return Opportunity("ОСВОБОДИ МЕСТО", "Гараж заполнен", "Перед новой покупкой учитываю лимит гаража и текущие открытые сделки.", 96)
            if (price != null && price > 0) {
                val forecast = CopilotState.dealForecast(context, v)
                val expected = if (forecast.has("expected_profit") && !forecast.isNull("expected_profit")) forecast.optLong("expected_profit") else 0L
                val roi = if (forecast.has("roi_percent") && !forecast.isNull("roi_percent")) forecast.optDouble("roi_percent") else 0.0
                if (expected > 0) return Opportunity("РАССМОТРИ", "Есть положительный прогноз", "Ожидаемая прибыль $expected ₽; ROI ${String.format("%.1f", roi)}%. Решение строится на накопленной истории, а не на марке автомобиля.", 89)
            }
            if (learned != 0) return Opportunity("ПРОВЕРЯЙ", "Есть накопленная история", "По этой машине/состоянию уже есть обученные результаты: $learned. Copilot продолжает уточнять прогноз по фактическим сделкам.", 78)
            return Opportunity("ПРОВЕРЯЙ", "Автомобиль найден", "Распознал карточку независимо от марки. Собираю цену, состояние, номер, характеристики, расходы, предложения и результат.", 75)
        }

        if (s.contains("ошибка") || s.contains("error")) return Opportunity("ПРОВЕРЬ", "Ошибка игры/экрана", "Copilot обнаружил сообщение об ошибке и не считает его прибыльным действием.", 90)
        return Opportunity("НАБЛЮДАЮ", "Сканирую игру", "Copilot анализирует текущий экран, ресурсы, задания, покупки, продажи, улучшения, аукционы и события в realtime.", 65)
    }
}
