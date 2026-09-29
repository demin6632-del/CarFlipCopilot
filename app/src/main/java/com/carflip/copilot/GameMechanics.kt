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
    private const val PENDING_ACTION = "pending_action"
    private const val LAST_ACTION = "last_action"
    private const val ACTION_WINDOW_MS = 60_000L
    private const val RULES = "rules"
    private const val RULE_MIN_CONFIRMATIONS = 2
    private const val SEQUENCES = "sequences"
    private const val SEQUENCE_MIN_CONFIRMATIONS = 2
    private const val LAST_RESULT = "last_result"
    private const val DEAL_CHAIN = "deal_chain"
    private const val MAX_CHAIN = 80

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


    private fun resourcesJson(resources: Map<String, Long>): JSONObject {
        val o = JSONObject()
        resources.forEach { (k, v) -> o.put(k, v) }
        return o
    }

    private fun resourceDelta(before: JSONObject, after: Map<String, Long>): String {
        val parts = mutableListOf<String>()
        val keys = mutableSetOf<String>()
        val beforeKeys = before.names()
        if (beforeKeys != null) {
            for (i in 0 until beforeKeys.length()) {
                keys += beforeKeys.optString(i)
            }
        }
        keys.addAll(after.keys)
        for (key in keys) {
            val b = before.optLong(key, Long.MIN_VALUE)
            val a = after[key] ?: Long.MIN_VALUE
            if (b != Long.MIN_VALUE && a != Long.MIN_VALUE && b != a) {
                val d = a - b
                parts += "${key}: ${b} -> ${a} (${if (d >= 0) "+" else ""}${d})"
            }
        }
        return parts.joinToString(", ")
    }

    private fun maybeRecordActionResult(
        c: Context,
        screen: String,
        balance: Long?,
        garage: Int,
        vehicleKey: String,
        resources: Map<String, Long>,
        now: Long
    ) {
        val p = prefs(c)
        val raw = p.getString(PENDING_ACTION, null) ?: return
        val pending = try { JSONObject(raw) } catch (_: Exception) {
            p.edit().remove(PENDING_ACTION).apply()
            return
        }
        val started = pending.optLong("time", 0L)
        if (started <= 0L || now - started > ACTION_WINDOW_MS) {
            p.edit().remove(PENDING_ACTION).apply()
            return
        }

        val beforeBalance = pending.optLong("balance", Long.MIN_VALUE)
        val beforeGarage = pending.optInt("garage", Int.MIN_VALUE)
        val beforeVehicle = pending.optString("vehicle", "")
        val beforeResources = try { JSONObject(pending.optString("resources", "{}")) } catch (_: Exception) { JSONObject() }

        val balanceChanged = balance != null && beforeBalance != Long.MIN_VALUE && balance != beforeBalance
        val garageChanged = beforeGarage != Int.MIN_VALUE && garage != beforeGarage
        val vehicleChanged = vehicleKey.isNotBlank() && beforeVehicle.isNotBlank() && vehicleKey != beforeVehicle
        val resourcesChanged = resourceDelta(beforeResources, resources).isNotBlank()
        if (!balanceChanged && !garageChanged && !vehicleChanged && !resourcesChanged) return

        val parts = mutableListOf<String>()
        if (balanceChanged) {
            val d = balance!! - beforeBalance
            parts += "balance: ${beforeBalance} -> ${balance} (${if (d >= 0) "+" else ""}${d} ₽)"
        }
        if (garageChanged) parts += "garage: ${beforeGarage} -> ${garage}"
        if (vehicleChanged) parts += "vehicle changed"
        if (resourcesChanged) parts += "resources: ${resourceDelta(beforeResources, resources)}"

        val action = pending.optString("action", "")
        val event = pending.optString("event", "")
        val label = listOf(action.takeIf { it.isNotBlank() }, event.takeIf { it.isNotBlank() })
            .filterNotNull().joinToString(" / ")

        val resultText = parts.joinToString("; ")
        recordTransition(c, "economy", "ACTION_RESULT: $label -> $resultText", screen, now)
        if (label.isNotBlank()) {
            recordRuleEvidence(c, actionRuleKey(label, parts), "economy", "ACTION_RESULT: $label -> $resultText", screen, now)
            recordObservedResult(c, label, resultText, screen, now)
        }
        if (garageChanged || vehicleChanged) {
            recordTransition(c, "cars", "ACTION_RESULT: $label -> $resultText", screen, now)
        }
        p.edit().remove(PENDING_ACTION).apply()
    }

    private fun rememberPendingAction(
        c: Context,
        screen: String,
        balance: Long?,
        garage: Int,
        vehicleKey: String,
        resources: Map<String, Long>,
        event: String?,
        action: String?,
        now: Long
    ) {
        val label = listOf(action?.takeIf { it.isNotBlank() }, event?.takeIf { it.isNotBlank() })
            .filterNotNull().joinToString(" / ")
        if (label.isBlank()) return

        val p = prefs(c)
        val previous = p.getString(LAST_ACTION, "")
        if (previous == label && p.contains(PENDING_ACTION)) return

        val pending = JSONObject()
            .put("time", now)
            .put("screen", screen)
            .put("action", action ?: "")
            .put("event", event ?: "")
            .put("balance", balance ?: Long.MIN_VALUE)
            .put("garage", garage)
            .put("vehicle", vehicleKey)
            .put("resources", resourcesJson(resources))
        p.edit().putString(PENDING_ACTION, pending.toString()).putString(LAST_ACTION, label).apply()
    }


    private fun recordRuleEvidence(c: Context, ruleKey: String, domain: String, evidence: String, screen: String, now: Long) {
        val p = prefs(c)
        val a = try { JSONArray(p.getString(RULES, "[]")) } catch (_: Exception) { JSONArray() }
        var found: JSONObject? = null
        for (i in 0 until a.length()) {
            val x = a.optJSONObject(i) ?: continue
            if (x.optString("key") == ruleKey) { found = x; break }
        }
        val rule = found ?: JSONObject().put("key", ruleKey).put("domain", domain).put("confirmations", 0).put("first_seen", now)
        val confirmations = rule.optInt("confirmations", 0) + 1
        rule.put("confirmations", confirmations)
            .put("last_seen", now)
            .put("evidence", evidence.take(500))
            .put("screen", screen)
            .put("status", if (confirmations >= RULE_MIN_CONFIRMATIONS) "CONFIRMED" else "OBSERVED_ONCE")
        if (found == null) a.put(rule)
        while (a.length() > 200) a.remove(0)
        p.edit().putString(RULES, a.toString()).apply()
    }

    private fun actionRuleKey(label: String, parts: List<String>): String =
        normalize(label) + " -> " + parts.joinToString("; ") { normalize(it).replace(Regex("\\d+"), "#") }

    private fun sequenceKey(from: String, to: String): String =
        normalize(from).replace(Regex("\\d+"), "#") + " -> " + normalize(to).replace(Regex("\\d+"), "#")

    private fun recordSequenceEvidence(c: Context, from: String, to: String, domain: String, evidence: String, screen: String, now: Long) {
        val p = prefs(c)
        val a = try { JSONArray(p.getString(SEQUENCES, "[]")) } catch (_: Exception) { JSONArray() }
        val key = sequenceKey(from, to)
        var found: JSONObject? = null
        for (i in 0 until a.length()) {
            val x = a.optJSONObject(i) ?: continue
            if (x.optString("key") == key) { found = x; break }
        }
        val seq = found ?: JSONObject()
            .put("key", key)
            .put("from", normalize(from))
            .put("to", normalize(to))
            .put("domain", domain)
            .put("confirmations", 0)
            .put("first_seen", now)
        val confirmations = seq.optInt("confirmations", 0) + 1
        seq.put("confirmations", confirmations)
            .put("last_seen", now)
            .put("evidence", evidence.take(500))
            .put("screen", screen)
            .put("status", if (confirmations >= SEQUENCE_MIN_CONFIRMATIONS) "DEPENDENCY_CONFIRMED" else "SEQUENCE_OBSERVED")
        if (found == null) a.put(seq)
        while (a.length() > 300) a.remove(0)
        p.edit().putString(SEQUENCES, a.toString()).apply()
    }

    private fun recordDealChain(c: Context, label: String, resultText: String, screen: String, now: Long) {
        if (label.isBlank()) return
        val p=prefs(c)
        val a=try{JSONArray(p.getString(DEAL_CHAIN,"[]"))}catch(_:Exception){JSONArray()}
        val item=JSONObject().put("label",normalize(label)).put("result",resultText.take(400)).put("screen",screen).put("time",now)
        a.put(item)
        while(a.length()>MAX_CHAIN)a.remove(0)
        p.edit().putString(DEAL_CHAIN,a.toString()).apply()
    }

    private fun recordObservedResult(c: Context, label: String, resultText: String, screen: String, now: Long) {
        if (label.isBlank()) return
        val current = normalize(label)
        val previous = prefs(c).getString(LAST_RESULT, "") ?: ""
        if (previous.isNotBlank() && previous != current) {
            recordSequenceEvidence(c, previous, current, "sequence",
                "observed result sequence: $previous -> $current; result=$resultText", screen, now)
        }
        recordDealChain(c,label,resultText,screen,now)
        prefs(c).edit().putString(LAST_RESULT, current).apply()
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
        val usableVehicleKey = vehicleKey.takeIf { it.isNotBlank() && it != "||||||" } ?: ""
        maybeRecordActionResult(c, screen, balance, garage, usableVehicleKey, resources, now)
        if (usableVehicleKey.isNotBlank()) {
            val previousVehicle = p.getString(LAST_VEHICLE, "") ?: ""
            if (previousVehicle.isNotBlank() && previousVehicle != vehicleKey) {
                recordTransition(c, "cars", "VEHICLE_CHANGED: $previousVehicle -> $vehicleKey", screen, now)
            }
            p.edit().putString(LAST_VEHICLE, usableVehicleKey).apply()
        }

        rememberPendingAction(c, screen, balance, garage, usableVehicleKey, resources, event, action, now)
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
        val rules = try { JSONArray(prefs(c).getString(RULES, "[]")) } catch (_: Exception) { JSONArray() }
        o.put("rules", rules)
        o.put("confirmed_rules", (0 until rules.length()).count { rules.optJSONObject(it)?.optString("status") == "CONFIRMED" })
        val sequences = try { JSONArray(prefs(c).getString(SEQUENCES, "[]")) } catch (_: Exception) { JSONArray() }
        o.put("sequences", sequences)
        o.put("confirmed_dependencies", (0 until sequences.length()).count { sequences.optJSONObject(it)?.optString("status") == "DEPENDENCY_CONFIRMED" })
        val chain=try{JSONArray(prefs(c).getString(DEAL_CHAIN,"[]"))}catch(_:Exception){JSONArray()}
        o.put("recent_deal_chain",chain)
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
