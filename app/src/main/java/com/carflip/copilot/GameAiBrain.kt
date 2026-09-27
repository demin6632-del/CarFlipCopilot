package com.carflip.copilot

import android.content.Context

/**
 * Основной игровой мозг. Он анализирует не только машины, а весь доступный
 * экран игры: контракты, рынок, продажу, номера, аукционы, улучшения,
 * соревнования, импорт, финансы, награды и ресурсы.
 */
object GameAiBrain {
    private const val PRODUCER = "Кинопродюсер"
    private const val MAX_PRICE = 2_500_000L
    private const val BONUS = 200_000L
    private const val RESERVE = 250_000L

    data class BrainResult(val opportunity: Opportunity, val urgent: Boolean = false)
    private data class Contract(val name:String, val usa:Boolean=false, val minHp:Int?=null, val maxPainted:Int?=null, val maxPrice:Long?=null, val bonus:Long=0)

    private fun o(a:String,t:String,r:String,c:Int,u:Boolean=false)=BrainResult(Opportunity(a,t,r,c),u)
    private fun hasCar(v:VehicleSnapshot)=v.name.isNotBlank()||v.price!=null||v.hp!=null||v.plate.isNotBlank()

    fun decide(c:Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int):BrainResult {
        val money=balance?:CopilotState.balance(c)
        val screen=GameScreenClassifier.classify(text)
        val s=text.lowercase()

        NewsParser.promo(text)?.let { return o("АКТИВИРОВАТЬ /promo "+it.code,"Промокод найден",
            "Нашёл "+it.code+if(it.limited)" • активации ограничены" else "",99,true) }

        GameParser.plateSaleEvent(text)?.let {
            return o("ЗАФИКСИРОВАТЬ","Продажа номера",
                it.plate+": выплата "+it.payout+" ₽, комиссия "+it.commission+" ₽.",99,true)
        }

        if(GameParser.plateAuctionNoBids(text)){
            return o("НЕ СТАВИТЬ","Номер возвращается на склад","Аукцион номера завершился без ставок. Деньги не тратим.",97,true)
        }

        val reward=GameParser.rewardAmount(text)
        if(reward!=null||screen=="НАГРАДА"||s.contains("забери награду")){
            return o("ПОЛУЧИ","Есть награда","Найдено игровое вознаграждение"+(reward?.let{" на "+it+" ₽"}?:"")+". Сначала забираем бесплатный бонус.",96,true)
        }

        if(s.contains("ошибка")||s.contains("error")||s.contains("недоступно")){
            return o("ЖДАТЬ","Игра сообщает об ошибке","Не принимаю экономическое решение по ошибочному экрану.",94,true)
        }

        when {
            screen=="АУКЦИОН_НОМЕРОВ"||GameParser.plateAuction(text) -> return plate(c,text,v)
            screen=="УЛИЧНЫЕ_ГОНКИ"||screen=="ПАРЫ_С_КОНКУРЕНТАМИ"||screen=="СОРЕВНОВАНИЕ" -> return competition(text)
            screen=="ИМПОРТ_ТАМОЖНЯ" -> return importDecision(text)
            screen=="ФИНАНСОВЫЙ_СЕКТОР"||screen=="ФИНАНСЫ"||screen=="БИЗНЕСЫ"||screen=="РАБОТА" -> return finance(text,money,screen)
            screen=="ПРОДАЖА"||s.contains("предложение покупателя") -> return sale(c,text,v)
            screen=="УЛУЧШЕНИЕ"||GameParser.action(text)!=null -> return upgrade(c,text,v)
        }

        val contract=contract(text)
        if(contract!=null||screen=="КОНТРАКТ_ЗАДАНИЕ"){
            if(hasCar(v)) return vehicle(c,text,v,money,garage,contract)
            return o("СРАВНИ","Контракт/задание","Сначала читаю требования, награду и стоимость выполнения. Не блокирую деньги без проверки.",90)
        }

        if(hasCar(v)||screen=="АВТО"||screen=="ПОКУПКА") return vehicle(c,text,v,money,garage,contract)

        if(screen=="ГАРАЖ"){
            return if(garage>=3) o("ОСВОБОДИ ГАРАЖ","Гараж заполнен","У тебя "+garage+"/3. Сначала закрываем слабую сделку.",93)
            else o("ОБЗОР","Гараж","Проверяю открытые сделки, номера и свободный капитал.",80)
        }

        if(screen=="РЫНОК_АВТО"||screen=="АВТОСАЛОН"){
            return o("ИЩИ ВЫГОДУ","Рынок открыт","Жду карточки машин и сравниваю цену входа с реальным спросом и расходами.",84)
        }

        return o("НАБЛЮДАЙ","Игра сканируется","Слежу за экономикой игры в реальном времени: машины, покупатели, номера, аукционы, контракты, расходы, награды и соревнования.",72)
    }

    private fun contract(text:String):Contract? {
        val s=text.lowercase()
        if(s.contains("кинопродюсер")){
            return Contract(PRODUCER,true,300,99,MAX_PRICE,BONUS)
        }
        val line=GameParser.contract(text) ?: return null
        val max=Regex("""(?:до|не более|макс\.?|лимит)[^0-9]{0,25}([0-9][0-9\s.,]*)\s*(?:₽|руб)""",RegexOption.IGNORE_CASE)
            .find(line)?.groupValues?.getOrNull(1)?.replace(Regex("[^0-9]"),"")?.toLongOrNull()
        val hp=Regex("""(?:от|>=|минимум)[^0-9]{0,12}([0-9]{2,4})\s*(?:л|л\.с|лошад|hp)""",RegexOption.IGNORE_CASE)
            .find(line)?.groupValues?.getOrNull(1)?.toIntOrNull()
        val paint=Regex("""(?:до|не более|макс\.?)[^0-9]{0,15}([0-9]{1,3})[^\n]{0,20}(?:крашен|окраш)""",RegexOption.IGNORE_CASE)
            .find(line)?.groupValues?.getOrNull(1)?.toIntOrNull()
        return Contract(line.take(60),s.contains("сша")||s.contains("usa")||s.contains("америк"),hp,paint,max,GameParser.rewardAmount(text)?:0)
    }

    private fun vehicle(c:Context,text:String,v:VehicleSnapshot,money:Long,garage:Int,rules:Contract?):BrainResult {
        val p=v.price
        if(garage>=3) return o("ОСВОБОДИ ГАРАЖ","Гараж заполнен","Новая машина сейчас заблокирует слот. Сначала закрой открытую сделку.",97)
        if(p!=null&&p>money) return o("НЕ ПОКУПАЙ","Не хватает денег","Цена "+p+" ₽ выше баланса "+money+" ₽.",99)

        rules?.let {
            if(it.maxPrice!=null&&p!=null&&p>it.maxPrice) return o("НЕ ПОКУПАЙ","Контракт не подходит по цене","Цена "+p+" ₽ выше лимита "+it.maxPrice+" ₽. Бонус "+it.bonus+" ₽ не помогает.",99)
            if(it.minHp!=null&&v.hp!=null&&v.hp<it.minHp) return o("НЕ ПОКУПАЙ","Не проходит контракт",v.hp+" л.с. меньше требуемых "+it.minHp+" л.с.",99)
            if(it.maxPainted!=null&&v.paintedParts!=null&&v.paintedParts>it.maxPainted) return o("НЕ ПОКУПАЙ","Слишком много окраса",v.paintedParts+" деталей выше лимита "+it.maxPainted+".",99)
            if(it.usa&&v.origin.isNotBlank()&&v.origin!="USA") return o("НЕ ПОКУПАЙ","Не проходит происхождение","Контракт требует USA/США, а распознано "+v.origin+".",99)
        }

        val f=CopilotState.dealForecast(c,v)
        val sale=f.optLong("sale_price",0)
        val profit=if(f.has("expected_profit")&&!f.isNull("expected_profit"))f.optLong("expected_profit")else null
        val roi=if(f.has("roi_percent")&&!f.isNull("roi_percent"))f.optDouble("roi_percent")else null

        if(rules!=null&&rules.bonus>0&&p!=null&&rules.maxPrice!=null&&p<=rules.maxPrice&&
            (!rules.usa||v.origin=="USA")&&(rules.minHp==null||(v.hp?:0)>=rules.minHp)&&
            (rules.maxPainted==null||(v.paintedParts?:0)<=rules.maxPainted)){
            if(profit!=null&&profit>0) return o("ПОКУПАЙ","Машина подходит под контракт",
                "Цена "+p+" ₽; бонус +"+rules.bonus+" ₽; прогноз продажи "+sale+" ₽; чистая прибыль +"+profit+" ₽"+(roi?.let{" • ROI "+String.format("%.1f",it)+"%"}?:"")+" .",96,true)
            if(v.origin=="USA"&&(v.hp?:0)>=300&&v.paintedParts!=null&&v.paintedParts<=99)
                return o("ПРОВЕРЬ И ПОКУПАЙ","Кандидат под контракт",
                    "Цена "+p+" ₽ проходит лимит; "+v.hp+" л.с.; USA; окрас "+v.paintedParts+"; бонус +"+rules.bonus+" ₽. Сначала доступная проверка, затем покупка.",91,true)
        }

        if(profit!=null&&profit>0&&p!=null)
            return o("ПОКУПАЙ","Есть положительная экономика",
                "Цена "+p+" ₽; прогноз продажи "+sale+" ₽; ожидаемая чистая прибыль +"+profit+" ₽"+(roi?.let{" • ROI "+String.format("%.1f",it)+"%"}?:"")+" .",90,true)

        val known=LearningMemory.estimatedSale(c,v,null)
        if(known!=null&&p!=null&&known>p)
            return o("ПОКУПАЙ","Есть история реального спроса",
                "Сохранённые предложения дают ориентир "+known+" ₽ против цены "+p+" ₽. Запас "+(known-p)+" ₽ до новых расходов.",87)

        if(p!=null) return o("ПРОВЕРЬ","Недостаточно данных для безопасной покупки",
            "Цена "+p+" ₽ известна, но надёжной цены выхода пока нет. Ищу спрос, историю и обязательные расходы.",84)

        return o("СОБИРАЙ ДАННЫЕ","Карточка неполная","Нужны цена, мощность, происхождение, пробег, владельцы, окрас и номер.",92)
    }

    private fun sale(c:Context,text:String,v:VehicleSnapshot):BrainResult {
        val direct=GameParser.saleAmount(text)
        if(direct!=null&&direct>0) return o("ЗАФИКСИРОВАТЬ","Продажа совершена","Выплата "+direct+" ₽. Сохраняю результат для обучения.",99,true)
        val f=CopilotState.dealForecast(c,v)
        val profit=if(f.has("expected_profit")&&!f.isNull("expected_profit"))f.optLong("expected_profit")else null
        if(profit!=null&&profit>0) return o("ПРОДАВАЙ","Прогноз положительный","Ожидаемая чистая прибыль +"+profit+" ₽. Перед подтверждением сверяю фактическое предложение.",90)
        return o("СРАВНИ ПРЕДЛОЖЕНИЯ","Идёт продажа","Запоминаю суммы и причины торга покупателей и выбираю выход по реальной экономике.",88)
    }

    private fun plate(c:Context,text:String,v:VehicleSnapshot):BrainResult {
        val plate=v.plate.ifBlank{GameParser.plate(text)}
        if(plate.isBlank()) return o("НАЙДИ НОМЕР","Номер не распознан","Без номера нельзя связать ставку, себестоимость, склад и итог аукциона.",90)
        val a=CopilotState.plateAuction(c,plate)
        val bid=CopilotState.plateBestBid(c,plate)?:GameParser.bidAmount(text)
        val cost=CopilotState.plateCost(c,plate)
        val fees=a.optLong("fees",0)
        if(bid!=null&&cost!=null&&cost>0){
            val net=bid-cost-fees
            val roi=net.toDouble()/cost*100.0
            if(net<0) return o("НЕ ПОВЫШАЙ","Номер уходит в минус","Ставка "+bid+" ₽; себестоимость "+cost+" ₽; комиссия "+fees+" ₽; результат "+net+" ₽; ROI "+String.format("%.1f",roi)+"%.",98)
            return o("ЖДАТЬ","Номер пока прибыльный","Ставка "+bid+" ₽; чистый результат "+net+" ₽; ROI "+String.format("%.1f",roi)+"%. Не повышай без нового обоснования.",92)
        }
        return o("СОБИРАЙ ДАННЫЕ","Аукцион номера","Связываю номер с себестоимостью, текущей ставкой, комиссией и финальной выплатой.",86)
    }

    private fun upgrade(c:Context,text:String,v:VehicleSnapshot):BrainResult {
        val action=GameParser.action(text)?:return o("НЕ ТРАТЬ","Расход не распознан","Не трачу деньги, пока не вижу конкретную услугу и стоимость.",92)
        val r=ActionRoiEngine.learned(c,v,action)
        if(r.realizedRoi!=null){
            return if(r.realizedRoi>0) o("РАССМОТРИ "+action,"Улучшение имеет историю",
                "Реализованный ROI "+String.format("%.1f",r.realizedRoi)+"% по "+r.realizedSamples+" наблюдениям.",r.confidence)
            else o("НЕ ТРАТЬ","Улучшение раньше не окупалось",
                "Реализованный ROI "+String.format("%.1f",r.realizedRoi)+"% по "+r.realizedSamples+" наблюдениям.",r.confidence)
        }
        return o("НЕ ТРАТЬ","Нет подтверждённого ROI","Сначала накопим фактические результаты по этому типу машины/состоянию.",78)
    }

    private fun competition(text:String):BrainResult {
        val cost=GameParser.expenseAmount(text)
        val reward=GameParser.rewardAmount(text)
        if(cost!=null&&reward!=null){
            return if(reward>cost)o("УЧАСТВУЙ","Награда выше входа","Вход "+cost+" ₽; награда "+reward+" ₽; видимый запас +"+(reward-cost)+" ₽. Учитывай риск проигрыша.",86)
            else o("НЕ УЧАСТВУЙ","Вход дороже награды","Вход "+cost+" ₽ против награды "+reward+" ₽.",92)
        }
        return o("ПРОВЕРЬ УСЛОВИЯ","Соревнование/дуэль","Нужны входная стоимость, награда и условия победы.",82)
    }

    private fun importDecision(text:String):BrainResult {
        val cost=GameParser.expenseAmount(text)
        val reward=GameParser.rewardAmount(text)
        if(cost!=null&&reward!=null){
            return if(reward>cost)o("РАССМОТРИ","Импорт имеет запас","Затраты "+cost+" ₽; видимая ценность "+reward+" ₽; разница "+(reward-cost)+" ₽. Нужны риски.",78)
            else o("НЕ БЕРИ РИСК","Импорт не покрывает вход","Затраты "+cost+" ₽ против ценности "+reward+" ₽.",90)
        }
        return o("СРАВНИ","Импорт/таможня","Сравниваю вход, таможенные расходы, цену выхода и денежный резерв.",80)
    }

    private fun finance(text:String,money:Long,screen:String):BrainResult {
        val cost=GameParser.expenseAmount(text)
        val reward=GameParser.rewardAmount(text)
        if(cost!=null&&reward!=null){
            return if(reward>cost)o("РАССМОТРИ",screen+" • положительная разница","Доход "+reward+" ₽ выше расхода "+cost+" ₽.",84)
            else o("НЕ ТРАТЬ",screen+" • отрицательная разница","Расход "+cost+" ₽ выше дохода "+reward+" ₽.",92)
        }
        if(money<RESERVE)return o("КОПИ НАЛИЧНЫЕ","Маленький резерв","Баланс "+money+" ₽. Пока нет подтверждённой прибыли — сохраняю ликвидность.",90)
        return o("КОНТРОЛИРУЙ",screen+" • экономика","Не блокируй весь баланс одной операцией. Слежу за расходами, кредитами и окупаемостью.",80)
    }
}
