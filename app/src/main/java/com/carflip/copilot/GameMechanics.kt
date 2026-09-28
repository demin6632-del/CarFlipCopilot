package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Evidence-driven model of the whole game.
 * It records systems actually observed on screen and never treats an
 * unobserved/unknown mechanic as a confirmed rule.
 */
object GameMechanics {
    private const val PREF = "copilot_mechanics"
    private const val FACTS = "facts"
    private const val MAX_FACTS = 600
    private const val LAST_BALANCE = "last_balance"
    private const val LAST_GARAGE = "last_garage"
    private const val LAST_VEHICLE = "last_vehicle"

    data class Observation(
        val domain: String,
        val type: String,
        val evidence: String,
        val screen: String,
        val time: Long
    )

    private data class Domain(
        val id: String,
        val label: String,
        val description: String,
        val signals: List<String>
    )

    private val domains = listOf(
        Domain("profile", "Профиль", "Уровень, опыт, уважение и общая прогрессия.", listOf("уровень", "опыт", "xp", "уваж", "репутац", "профиль")),
        Domain("economy", "Экономика", "Баланс, доходы, расходы, комиссии и движение капитала.", listOf("баланс", "деньги", "доход", "расход", "комис", "прибыл", "убыт")),
        Domain("garage", "Гараж", "Слоты гаража и управление открытыми автомобилями.", listOf("гараж", "места в гараже", "расширить гараж")),
        Domain("cars", "Автомобили", "Карточки машин, характеристики, состояние и история.", listOf("пробег", "лошад", "владель", "крашен", "мощность", "автомобиль", "машина")),
        Domain("buying", "Покупка", "Поиск и приобретение автомобилей/активов.", listOf("купить", "покупка", "куплен", "цена покупки")),
        Domain("selling", "Продажа", "Выставление автомобиля, предложения и завершение продажи.", listOf("продать", "продажа", "продан", "предложение покупателя")),
        Domain("negotiation", "Переговоры", "Торг и предложения продавцов/покупателей.", listOf("торг", "предложение", "скидк", "переговор")),
        Domain("inspection", "Проверки", "Диагностика, осмотр и проверка автомобиля.", listOf("осмотр", "диагност", "проверка", "автотек")),
        Domain("upgrades", "Ремонт и улучшения", "Ремонт, полировка, окраска, тюнинг и отдельные услуги.", listOf("ремонт", "полиров", "окрас", "турбин", "чип", "тюнинг", "шины", "тормоз", "подвес")),
        Domain("plates", "Номера", "Хранение, снятие, установка и ценность государственных номеров.", listOf("номер", "госномер", "склад номеров", "снять номер")),
        Domain("plate_auction", "Аукцион номеров", "Ставки, возврат без ставок, продажа и комиссия.", listOf("аукцион номеров", "госномер выставлен", "номер выставлен на аукцион", "ставка за номер", "продажа номера с аукциона", "номер вернулся", "комиссия аукциона номера")),
        Domain("contracts", "Контракты и задания", "Требования, награды и условия выполнения.", listOf("контракт", "заказ", "квест", "миссия", "задание")),
        Domain("rewards", "Награды", "Получение бонусов, призов и других вознаграждений.", listOf("награда", "бонус", "приз", "выигрыш")),
        Domain("import", "Импорт и таможня", "Импорт автомобиля и связанные с ним расходы/условия.", listOf("импорт", "тамож", "растамож")),
        Domain("finance", "Финансы", "Банк, кредиты, лимиты и другие финансовые операции.", listOf("банк", "кредит", "лимит", "финансов")),
        Domain("business", "Бизнесы", "Покупка/управление бизнесами и их доходность.", listOf("бизнес", "окупаемость", "доход бизнеса")),
        Domain("work", "Работа", "Рабочие активности и доход за смену.", listOf("работа", "зарплата", "смена")),
        Domain("competition", "Соревнования", "Гонки, дуэли и другие платные/наградные активности.", listOf("гонка", "заезд", "дуэль", "соревнован", "испытан")),
        Domain("clans", "Кланы", "Клановая система и связанные активности.", listOf("клан", "синдикат")),
        Domain("referrals", "Рефералы", "Реферальные механики и приглашения.", listOf("реферал", "пригласить друга")),
        Domain("social", "Социальные активности", "Сходки, рейтинги и взаимодействие с игроками.", listOf("сходка", "топ игроков", "рейтинг игроков")),
        Domain("market", "Рынки", "Общие и частные авторынки/автосалоны.", listOf("рынок авто", "авторынок", "частный рынок", "автосалон")),
        Domain("shop", "Магазин услуг", "Доступные сервисы и платные игровые услуги.", listOf("магазин услуг", "автомойка", "малярный цех", "шиномонтаж", "детейлинг", "запчасти"))
    )

    private fun prefs(c: Context) = c.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    private fun normalize(s: String): String =
        s.lowercase().replace('ё', 'е').replace(Regex("\\s+"), " ").trim()

    private fun appendFact(c: Context, observation: Observation) {
        val p = prefs(c)
        val a = try { JSONArray(p.getString(FACTS, "[]")) } catch (_: Exception) { JSONArray() }
        a.put(JSONObject()
            .put("domain", observation.domain)
            .put("type", observation.type)
            .put("evidence", observation.evidence.take(500))
            .put("screen", observation.screen)
            .put("time", observation.time))
        while (a.length() > MAX_FACTS) a.remove(0)
        p.edit().putString(FACTS, a.toString()).apply()
    }

    private fun recordTransition(c: Context, domain: String, evidence: String, screen: String, now: Long) {
        val key = "transition:" + domain + ":" + evidence.take(180)
        val p = prefs(c)
        val last = p.getLong(key, 0L)
        if (now - last < 2_000L) return
        p.edit().putLong(key, now).apply()
        appendFact(c, Observation(domain, "STATE_CHANGE", evidence, screen, now))
    }

    private fun seen(c: Context, domain: String): Int {
        val a = try { JSONArray(prefs(c).getString(FACTS, "[]")) } catch (_: Exception) { JSONArray() }
        var n = 0
        for (i in 0 until a.length()) if (a.optJSONObject(i)?.optString("domain") == domain) n++
        return n
    }

    fun observe(
        c: Context,
        text: String,
        screen: String,
        vehicle: VehicleSnapshot,
        balance: Long?,
        garage: Int,
        event: String? = null,
        action: String? = null,
        resources: Map<String, Long> = emptyMap()
    ) {
        val n = normalize(text)
        val now = System.currentTimeMillis()
        val explicit = mutableSetOf<String>()
        val p = prefs(c)

        if (balance != null && balance > 0L) {
            val previous = if (p.contains(LAST_BALANCE)) p.getLong(LAST_BALANCE, balance) else balance
            if (p.contains(LAST_BALANCE) && previous != balance) {
                val delta = balance - previous
                recordTransition(c, "economy", "BALANCE_CHANGED: $previous -> $balance (${if (delta >= 0) "+" else ""}$delta ₽)" +
                    (if (!event.isNullOrBlank()) " • event=$event" else "") +
                    (if (!action.isNullOrBlank()) " • action=$action" else ""), screen, now)
            }
            p.edit().putLong(LAST_BALANCE, balance).apply()
        }

        if (garage >= 0) {
            val previousGarage = if (p.contains(LAST_GARAGE)) p.getInt(LAST_GARAGE, garage) else garage
            if (p.contains(LAST_GARAGE) && previousGarage != garage) {
                recordTransition(c, "garage", "GARAGE_CHANGED: $previousGarage -> $garage", screen, now)
            }
            p.edit().putInt(LAST_GARAGE, garage).apply()
        }

        val vehicleKey = listOf(vehicle.name, vehicle.plate, vehicle.price, vehicle.hp, vehicle.mileage, vehicle.owners, vehicle.paintedParts).joinToString("|")
        if (vehicleKey.isNotBlank() && vehicleKey != "||||||") {
            val previousVehicle = p.getString(LAST_VEHICLE, "") ?: ""
            if (previousVehicle.isNotBlank() && previousVehicle != vehicleKey) {
                recordTransition(c, "cars", "VEHICLE_CHANGED: $previousVehicle -> $vehicleKey", screen, now)
            }
            p.edit().putString(LAST_VEHICLE, vehicleKey).apply()
        }

        domains.forEach { d -> if (d.signals.any { n.contains(it) }) explicit += d.id }
        if (vehicle.name.isNotBlank() || vehicle.price != null || vehicle.hp != null || vehicle.plate.isNotBlank()) explicit += "cars"
        if (balance != null) explicit += "economy"
        if (garage >= 0) explicit += "garage"

        event?.let {
            when {
                it.contains("ПРОДАЖА_НОМЕРА") -> explicit += "plate_auction"
                it.contains("АУКЦИОН_НОМЕРА") || it.contains("АУКЦИОН НОМЕРОВ") -> explicit += "plate_auction"
                it.contains("ПРОДАЖА") -> explicit += "selling"
                it.contains("ПОКУПКА") -> explicit += "buying"
                it.contains("НАГРАДА") -> explicit += "rewards"
                it.contains("ЗАДАНИЕ") -> explicit += "contracts"
            }
        }

        action?.let {
            explicit += "upgrades"
            if (it == "ДИАГНОСТИКА") explicit += "inspection"
        }

        if (resources.keys.any { it in setOf("топливо", "энергия", "монеты", "жетоны") }) explicit += "economy"

        explicit.forEach { id ->
            val domain = domains.firstOrNull { it.id == id } ?: return@forEach
            val evidence = when {
                !event.isNullOrBlank() -> event
                !action.isNullOrBlank() -> "действие=" + action
                vehicle.name.isNotBlank() -> "машина=" + vehicle.name
                else -> screen.ifBlank { domain.label }
            }
            val key = id + ":" + screen + ":" + evidence.take(100)
            val p = prefs(c)
            val last = p.getLong("last:" + key, 0L)
            if (now - last >= 30_000L) {
                p.edit().putLong("last:" + key, now).apply()
                appendFact(c, Observation(id, "OBSERVED", evidence, screen, now))
            }
        }
    }

    fun snapshot(c: Context): JSONObject {
        val o = JSONObject()
        val domainsJson = JSONArray()
        val a = try { JSONArray(prefs(c).getString(FACTS, "[]")) } catch (_: Exception) { JSONArray() }

        for (d in domains) {
            var last = 0L
            var lastEvidence = ""
            for (i in a.length() - 1 downTo 0) {
                val x = a.optJSONObject(i) ?: continue
                if (x.optString("domain") != d.id) continue
                last = x.optLong("time")
                lastEvidence = x.optString("evidence")
                break
            }
            domainsJson.put(JSONObject()
                .put("id", d.id)
                .put("name", d.label)
                .put("description", d.description)
                .put("observed", last > 0L)
                .put("observations", seen(c, d.id))
                .put("last_seen", last)
                .put("last_evidence", lastEvidence))
        }
        o.put("domains", domainsJson)
        o.put("observed_domains", domains.count { seen(c, it.id) > 0 })
        o.put("total_domains", domains.size)
        o.put("facts", a.length())
        return o
    }

    fun recent(c: Context, limit: Int = 40): JSONArray {
        val a = try { JSONArray(prefs(c).getString(FACTS, "[]")) } catch (_: Exception) { JSONArray() }
        val out = JSONArray()
        val from = (a.length() - limit.coerceAtMost(a.length())).coerceAtLeast(0)
        for (i in a.length() - 1 downTo from) a.optJSONObject(i)?.let { out.put(it) }
        return out
    }

    fun clear(c: Context) = prefs(c).edit().clear().apply()
}
