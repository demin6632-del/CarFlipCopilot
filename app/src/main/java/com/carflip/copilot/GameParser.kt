package com.carflip.copilot

object GameParser {
    data class PlateSaleEvent(
        val plate: String,
        val payout: Long,
        val commission: Long,
        val commissionPercent: Double?,
        val gross: Long?
    )

    private val money = Regex("(\\d[\\d\\s.,]*)\\s*(?:₽|руб|rub|\\$|usd|€|eur)", RegexOption.IGNORE_CASE)
    private val number = Regex("\\d[\\d\\s.,]*")

    private fun numberAfter(text: String, keywords: List<String>): Long? {
        val s = text.lowercase()
        for (k in keywords) {
            val i = s.indexOf(k)
            if (i < 0) continue
            val tail = text.substring(i).take(260)
            val m = money.find(tail) ?: number.find(tail) ?: continue
            val n = m.groupValues[1].replace(Regex("[^0-9]"), "").toLongOrNull()
            if (n != null && n > 0) return n
        }
        return null
    }

    private fun amount(text: String, keywords: List<String>): Long? = numberAfter(text, keywords)

    fun price(text: String): Long? = amount(text, listOf("цена", "стоимость", "купить", "покупка", "price", "buy", "вложено в авто", "вложено в машину", "вложено в проект", "вложено в проекте", "вложено", "инвестировано", "asking"))
    fun purchaseAmount(text: String): Long? = amount(text, listOf("покуп", "купил", "купить", "цена покупки", "buy", "вложено в авто", "вложено в проект"))
    fun saleAmount(text: String): Long? = amount(text, listOf("продан", "продажа", "продать", "продал", "sale", "sold", "выручка", "выплата"))
    fun expenseAmount(text: String): Long? = amount(text, listOf("расход", "ремонт", "стоимость ремонта", "оплат", "комис", "fee", "затрат", "стоимость"))
    fun balance(text: String): Long? = amount(text, listOf("баланс", "деньги", "счёт", "счет", "balance", "cash", "банк"))
    fun rewardAmount(text: String): Long? = amount(text, listOf("награда", "бонус", "reward", "bonus", "приз", "prize", "выигрыш"))
    fun bidAmount(text: String): Long? = amount(text, listOf("ставка", "bid", "текущая ставка", "предложение", "offer"))

    fun hp(text: String): Int? = Regex("(\\d{2,4})\\s*(?:л\\.?\\s*с\\.?|лошад|hp|bhp)", RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1)?.toIntOrNull()
    fun mileage(text: String): Long? = Regex("(?:пробег|mileage|km|км)\\D{0,30}(\\d[\\d\\s.,]*)", RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1)?.replace(Regex("[^0-9]"), "")?.toLongOrNull()
    fun owners(text: String): Int? = Regex("(?:владельц|owner|owners)\\D{0,20}(\\d{1,2})", RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1)?.toIntOrNull()

    fun percent(text: String, keywords: List<String> = emptyList()): Double? {
        val source = if (keywords.isEmpty()) text else text.lines().firstOrNull { line -> keywords.any { line.contains(it, true) } } ?: return null
        return Regex("(-?\\d+(?:[.,]\\d+)?)\\s*%").find(source)?.groupValues?.get(1)?.replace(',', '.')?.toDoubleOrNull()
    }

    fun plate(text: String): String {
        val normalized = text.uppercase()
            .replace('О', 'O').replace('А', 'A').replace('В', 'B').replace('Е', 'E')
            .replace('К', 'K').replace('М', 'M').replace('Н', 'H').replace('Р', 'P')
            .replace('С', 'C').replace('Т', 'T').replace('У', 'Y').replace('Х', 'X')
            .replace(Regex("[|¦]"), "I")
        val compact = normalized.replace(Regex("[^A-Z0-9]"), "")
        val patterns = listOf(Regex("[A-Z]\\d{3}[A-Z]{2}\\d{2,3}"), Regex("[A-Z]\\d{3}[A-Z]{2}\\d{2}"))
        return patterns.asSequence().mapNotNull { it.find(compact) }.firstOrNull()?.value ?: ""
    }

    fun origin(text: String): String {
        val s = text.lowercase()
        return when {
            s.contains("usa") || s.contains("сша") || s.contains("америк") -> "USA"
            s.contains("japan") || s.contains("япон") -> "JAPAN"
            s.contains("germany") || s.contains("герман") || s.contains("немец") -> "GERMANY"
            s.contains("italy") || s.contains("итал") -> "ITALY"
            s.contains("france") || s.contains("франц") -> "FRANCE"
            "korea" in s || "коре" in s -> "KOREA"
            "china" in s || "кита" in s -> "CHINA"
            "uk" in s || "англи" in s || "британ" in s -> "UK"
            "russia" in s || "росси" in s || "русск" in s -> "RUSSIA"
            else -> ""
        }
    }

    fun paintedParts(text: String): Int? = Regex("(?:крашен|окрашен|painted|paint)\\D{0,40}(\\d{1,3})", RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1)?.toIntOrNull()

    fun name(text: String): String {
        val lines = text.lines().map { it.trim().replace(Regex("\\s+"), " ") }.filter { it.length in 3..100 }
        val explicit = Regex("(?i)([A-ZА-ЯЁ][A-Za-zА-ЯЁа-яё0-9 ._/-]{2,70})\\s*\\(")
        explicit.find(text)?.groupValues?.getOrNull(1)?.trim()?.let { if (it.length >= 3) return it }
        val stop = Regex("^(цена|стоимость|пробег|владель|мощность|баланс|купить|продать|гараж|номер|paint|hp|вложено|предложение|убыток|по рукам|ресурс|крашен|ставк|аукцион|контракт|заказ|награда|бонус|ремонт|расход|комис|сч[её]т|деньги|cash|balance)", RegexOption.IGNORE_CASE)
        return lines.firstOrNull { line ->
            line.any(Char::isLetter) &&
                !stop.containsMatchIn(line) &&
                !Regex("^[-+]?\\d[\\d\\s.,]*([₽$€%]|л\\.?с\\.?|hp|km|км)?$", RegexOption.IGNORE_CASE).matches(line) &&
                line.count(Char::isLetter) >= 3
        } ?: ""
    }

    fun garage(text: String): Int? = Regex("(?:гараж|garage)\\D{0,10}(\\d{1,2})\\s*/\\s*(\\d{1,2})", RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1)?.toIntOrNull()

    fun contract(text: String): String? {
        val line = text.lines().firstOrNull { val s = it.lowercase(); s.contains("контракт") || s.contains("заказ") || s.contains("quest") || s.contains("квест") || s.contains("mission") || s.contains("мисси") }
        return line?.trim()?.takeIf { it.isNotBlank() }
    }

    fun event(text: String): String? {
        plateSaleEvent(text)?.let { sale ->
            return "ПРОДАЖА_НОМЕРА • ${sale.plate} • выплата=${sale.payout} ₽ • комиссия=${sale.commission} ₽${sale.commissionPercent?.let { " (${it}%)" } ?: ""}${sale.gross?.let { " • до комиссии=${it} ₽" } ?: ""}"
        }
        if (plateAuctionNoBids(text)) {
            val p = plate(text)
            return if (p.isBlank()) {
                "АУКЦИОН_НОМЕРА_БЕЗ_СТАВОК • номер возвращён на склад • продажа=0 ₽"
            } else {
                "АУКЦИОН_НОМЕРА_БЕЗ_СТАВОК • $p • возвращён на склад • продажа=0 ₽"
            }
        }
        val s = text.lowercase()
        return when {
            s.contains("продан") || s.contains("продажа") || s.contains("продал") || s.contains("sold") -> "ПРОДАЖА"
            s.contains("куплен") || s.contains("покупка") || s.contains("купил") || s.contains("bought") -> "ПОКУПКА"
            s.contains("аукцион") || s.contains("ставк") || s.contains("auction") || s.contains("bid") -> "АУКЦИОН"
            s.contains("награда") || s.contains("бонус") || s.contains("reward") || s.contains("bonus") || s.contains("приз") -> "НАГРАДА"
            s.contains("контракт") || s.contains("заказ") || s.contains("квест") || s.contains("quest") || s.contains("mission") -> "ЗАДАНИЕ"
            action(text) != null -> "ДЕЙСТВИЕ"
            else -> null
        }
    }

    fun screenType(text: String): String {
        val s = text.lowercase()
        return when {
            plateAuction(text) -> "АУКЦИОН_НОМЕРА"
            carAuction(text) -> "АУКЦИОН"
            s.contains("гараж") || s.contains("garage") -> "ГАРАЖ"
            s.contains("магазин") || s.contains("shop") || s.contains("магаз") -> "МАГАЗИН"
            s.contains("контракт") || s.contains("заказ") || s.contains("квест") || s.contains("quest") || s.contains("mission") -> "ЗАДАНИЕ"
            s.contains("награда") || s.contains("бонус") || s.contains("reward") || s.contains("bonus") || s.contains("приз") -> "НАГРАДА"
            s.contains("продать") || s.contains("продажа") || s.contains("продан") || s.contains("sell") || s.contains("sold") -> "ПРОДАЖА"
            s.contains("купить") || s.contains("покупка") || s.contains("куплен") || s.contains("buy") || s.contains("market") -> "ПОКУПКА"
            s.contains("ремонт") || s.contains("полиров") || s.contains("окрас") || s.contains("турбин") || s.contains("чип") || s.contains("upgrade") || s.contains("тюнинг") -> "УЛУЧШЕНИЕ"
            s.contains("осмотр") || s.contains("диагност") || s.contains("inspection") -> "ПРОВЕРКА"
            name(text).isNotBlank() || price(text) != null || hp(text) != null || plate(text).isNotBlank() -> "АВТО"
            s.contains("гонк") || s.contains("race") || s.contains("заезд") || s.contains("challenge") || s.contains("испытан") -> "СОРЕВНОВАНИЕ"
            s.contains("банк") || s.contains("bank") || s.contains("кредит") || s.contains("loan") -> "ФИНАНСЫ"
            else -> "ОБЗОР"
        }
    }

    fun resources(text: String): Map<String, Long> {
        val result = linkedMapOf<String, Long>()
        val patterns = listOf(
            "деньги" to listOf("деньги", "баланс", "cash", "balance"),
            "топливо" to listOf("топливо", "бензин", "fuel"),
            "опыт" to listOf("опыт", "xp", "experience"),
            "репутация" to listOf("репутац", "reputation"),
            "энергия" to listOf("энергия", "energy"),
            "монеты" to listOf("монет", "coins", "coin"),
            "жетоны" to listOf("жетон", "tokens", "token")
        )
        for ((key, words) in patterns) numberAfter(text, words)?.let { result[key] = it }
        return result
    }

    fun action(text: String): String? {
        val s = text.lowercase()
        val rules = listOf(
            Regex("\\bчип\\b|\\bchip\\b") to "ЧИП",
            Regex("турбин|turbo|supercharger") to "ТУРБИНА",
            Regex("полиров|polish|detailing") to "ПОЛИРОВКА",
            Regex("окрас|покрас|paint|bodywork") to "ОКРАСКА",
            Regex("ремонт|repair|fix") to "РЕМОНТ",
            Regex("диагност|diagnostic|inspection|осмотр") to "ДИАГНОСТИКА",
            Regex("двигател|engine|мотор") to "ДВИГАТЕЛЬ",
            Regex("тормоз|brake") to "ТОРМОЗА",
            Regex("подвес|suspension") to "ПОДВЕСКА",
            Regex("шины|резин|tire|tyre") to "ШИНЫ",
            Regex("диск|колес|wheel|rim") to "КОЛЁСА",
            Regex("салон|interior") to "САЛОН",
            Regex("аудио|audio|sound") to "АУДИО",
            Regex("нитро|nitro") to "НИТРО",
            Regex("мойк|мойка|wash") to "МОЙКА",
            Regex("страхов|insurance") to "СТРАХОВКА",
            Regex("регистрац|registration") to "РЕГИСТРАЦИЯ",
            Regex("доставка|delivery") to "ДОСТАВКА"
        )
        return rules.firstOrNull { it.first.containsMatchIn(s) }?.second
    }

    /** Price of the car explicitly offered without its plate. Never falls back to a normal sale price. */
    fun carWithoutPlateSale(text: String): Long? {
        val lines = text.lines().filter { line ->
            val s = line.lowercase()
            (s.contains("без номера") || s.contains("без госномер") || s.contains("without plate") || s.contains("without number")) &&
                (s.contains("прод") || s.contains("цена") || s.contains("предлож"))
        }
        for (line in lines) {
            numberAfter(line, listOf("продаж", "цена", "предлож", "получ"))?.let { return it }
        }
        return null
    }

    fun plateOffer(text: String): Long? {
        val x = text.lowercase()
        val re = Regex("(?i)(?:предложение|ставка|цена)\\s*(?:за|на)?\\s*(?:гос)?номер[^0-9]{0,50}(\\d[\\d\\s.,]*)\\s*(?:₽|руб|rub)?")
        val m = re.find(x) ?: Regex("(?i)(?:гос)?номер[^0-9]{0,30}(?:предложение|ставка|цена)[^0-9]{0,30}(\\d[\\d\\s.,]*)").find(x)
        return m?.groupValues?.getOrNull(1)?.replace(Regex("[^0-9]"), "")?.toLongOrNull()?.takeIf { it > 0 }
    }

    fun plateSale(text: String): Long? = plateSaleEvent(text)?.payout

    fun plateCommission(text: String): Long? = plateSaleEvent(text)?.commission

    fun plateGross(text: String): Long? = plateSaleEvent(text)?.gross

    fun plateSaleEvent(text: String): PlateSaleEvent? {
        val x = text.replace('\u00A0', ' ')
        val lower = x.lowercase()
        val saleMarker = lower.contains("твой номер продан") || lower.contains("номер продан с аукциона") || (lower.contains("номер") && lower.contains("продан") && lower.contains("аукцион"))
        if (!saleMarker) return null
        val plateValue = plate(x)
        if (plateValue.isBlank()) return null
        val payout = numberAfter(x, listOf("выплата", "получишь", "получено", "выручка")) ?: return null
        val commissionPercent = percent(x, listOf("комиссия", "commission"))
        val commissionExplicit = numberAfter(x, listOf("комиссия", "комис"))
        val commission = commissionExplicit ?: commissionPercent?.let { pct ->
            if (pct >= 0.0 && pct < 100.0) (payout * pct / (100.0 - pct)).toLong() else null
        } ?: 0L
        val gross = if (commission > 0) payout + commission else commissionPercent?.let { pct ->
            if (pct in 0.0..99.999) (payout / (1.0 - pct / 100.0)).toLong() else null
        }
        return PlateSaleEvent(plateValue, payout, commission, commissionPercent, gross)
    }

    fun plateAuctionNoBids(text: String): Boolean {
        val x = text.lowercase().replace('ё', 'е')
        val auction = x.contains("торги") || x.contains("аукцион") || x.contains("auction") || x.contains("bidding")
        val noBids = x.contains("без ставок") || x.contains("нет ставок") || x.contains("no bids") || x.contains("no bid")
        val returned = x.contains("возвращен") || x.contains("возвращен на склад") || x.contains("вернул") || x.contains("returned") || x.contains("storage")
        val plateContext = x.contains("номер") || x.contains("госномер") || x.contains("plate")
        return auction && noBids && returned && plateContext
    }

    fun plateAuction(text: String): Boolean {
        val x = text.lowercase()
        return (x.contains("аукцион") || x.contains("ставк") || x.contains("auction") || x.contains("bid")) && (x.contains("номер") || x.contains("госномер") || x.contains("plate"))
    }

    fun carAuction(text: String): Boolean {
        val x = text.lowercase()
        return (x.contains("аукцион") || x.contains("ставк") || x.contains("auction") || x.contains("bid")) && !(x.contains("номер") || x.contains("госномер") || x.contains("plate"))
    }

    fun plateRemoved(text: String): Boolean {
        val x = text.lowercase()
        return x.contains("снять номер") || x.contains("снятие номера") || x.contains("снял номер") || x.contains("remove plate") || x.contains("remove number")
    }

    fun decision(v: VehicleSnapshot): String = if (v.price == null && v.name.isBlank()) "НАБЛЮДАЮ" else "АНАЛИЗ"
}
