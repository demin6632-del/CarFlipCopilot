package com.carflip.copilot

object GameParser {
    private val money = Regex("(\\d[\\d\\s.,]*)\\s*(?:₽|руб|rub)", RegexOption.IGNORE_CASE)
    private fun amount(text:String, keywords:List<String>):Long? {
        val s=text.lowercase()
        for (k in keywords) {
            val i=s.indexOf(k)
            if(i<0) continue
            val tail=text.substring(i).take(180)
            val m=money.find(tail) ?: Regex("(\\d[\\d\\s.,]*)").find(tail) ?: continue
            val n=m.groupValues[1].replace(Regex("[^0-9]"),"").toLongOrNull()
            if(n!=null&&n>0)return n
        }
        return null
    }
    fun price(text:String):Long? = amount(text,listOf("цена","стоимость","купить","покупка","price"))
    fun purchaseAmount(text:String):Long? = amount(text,listOf("покуп","купил","купить","цена покупки","buy"))
    fun saleAmount(text:String):Long? = amount(text,listOf("продан","продажа","продать","продал","sale"))
    fun expenseAmount(text:String):Long? = amount(text,listOf("расход","ремонт","стоимость ремонта","оплат","комис","fee"))
    fun balance(text:String):Long? = amount(text,listOf("баланс","деньги","счёт","счет","balance"))

    fun hp(text:String):Int? {
        val m=Regex("(\\d{2,4})\\s*(?:л\\.?\\s*с\\.?|лошад|hp)",RegexOption.IGNORE_CASE).find(text) ?: return null
        return m.groupValues[1].toIntOrNull()
    }
    fun mileage(text:String):Long? {
        val m=Regex("(?:пробег|mileage)\\D{0,20}(\\d[\\d\\s.,]*)",RegexOption.IGNORE_CASE).find(text) ?: return null
        return m.groupValues[1].replace(Regex("[^0-9]"),"").toLongOrNull()
    }
    fun owners(text:String):Int? {
        val m=Regex("(?:владельц|owner)\\D{0,15}(\\d{1,2})",RegexOption.IGNORE_CASE).find(text) ?: return null
        return m.groupValues[1].toIntOrNull()
    }
    fun plate(text:String):String {
        val m=Regex("\\b[A-ZА-Я]\\s*\\d{3}\\s*[A-ZА-Я]{2}\\s*\\d{2,3}\\b",RegexOption.IGNORE_CASE).find(text)
        return m?.value?.replace(" ","")?.uppercase() ?: ""
    }
    fun origin(text:String):String {
        val s=text.lowercase()
        return when {
            s.contains("usa")||s.contains("сша")||s.contains("америк") -> "USA"
            s.contains("japan")||s.contains("япон") -> "JAPAN"
            s.contains("germany")||s.contains("герман")||s.contains("немец") -> "GERMANY"
            s.contains("italy")||s.contains("итал") -> "ITALY"
            else -> ""
        }
    }
    fun paintedParts(text:String):Int? {
        val m=Regex("(?:крашен|окрашен|painted)\\D{0,30}(\\d{1,3})",RegexOption.IGNORE_CASE).find(text) ?: return null
        return m.groupValues[1].toIntOrNull()
    }
    fun name(text:String):String {
        val lines=text.lines().map{it.trim()}.filter{it.length in 3..80}
        val stop=Regex("^(цена|стоимость|пробег|владель|мощность|баланс|купить|продать|гараж|номер|paint|hp)",RegexOption.IGNORE_CASE)
        return lines.firstOrNull{it.any(Char::isLetter)&&!stop.containsMatchIn(it)&&it.count(Char::isDigit)<it.length/2} ?: ""
    }
    fun garage(text:String):Int? {
        val m=Regex("(?:гараж|garage)\\D{0,10}(\\d{1,2})\\s*/\\s*(\\d{1,2})",RegexOption.IGNORE_CASE).find(text)
        return m?.groupValues?.get(1)?.toIntOrNull()
    }
    fun contract(text:String):String? {
        val s=text.lowercase()
        return if(s.contains("контракт")||s.contains("заказ")) text.lines().firstOrNull{it.lowercase().contains("контракт")||it.lowercase().contains("заказ")}?.trim() else null
    }
    fun event(text:String):String? {
        val s=text.lowercase()
        return when {
            s.contains("продан")||s.contains("продажа")||s.contains("продал") -> "ПРОДАЖА"
            s.contains("куплен")||s.contains("покупка")||s.contains("купил") -> "ПОКУПКА"
            s.contains("аукцион")||s.contains("ставк") -> "АУКЦИОН"
            s.contains("ремонт")||s.contains("полиров")||s.contains("окрас")||s.contains("турбин")||s.contains("чип") -> "РАСХОД"
            else -> null
        }
    }
    fun plateOffer(text:String):Long? = amount(text,listOf("номер","предложение за номер","за номер","plate"))
    fun plateSale(text:String):Long? = amount(text,listOf("продал номер","продажа номера","номер продан","продан номер","plate sold"))
    fun plateRemoved(text:String):Boolean { val x=text.lowercase(); return x.contains("снять номер")||x.contains("снятие номера")||x.contains("снял номер")||x.contains("remove plate") }
        fun action(text:String):String? {
        val s=text.lowercase()
        return when {
            Regex("\\bчип\\b|chip").containsMatchIn(s) -> "ЧИП"
            s.contains("турбин")||s.contains("turbo") -> "ТУРБИНА"
            s.contains("полиров")||s.contains("polish") -> "ПОЛИРОВКА"
            s.contains("окрас")||s.contains("покрас")||s.contains("paint") -> "ОКРАСКА"
            s.contains("ремонт")||s.contains("repair") -> "РЕМОНТ"
            s.contains("диагност")||s.contains("diagnostic") -> "ДИАГНОСТИКА"
            else -> null
        }
    }
    fun decision(v:VehicleSnapshot):String {
        return when {
            v.price==null && v.name.isBlank() -> "НАБЛЮДАЮ"
            else -> "АНАЛИЗ"
        }
    }
}
