package com.carflip.copilot

data class PlanForecast(
    val balanceAfter:Long?,
    val garageAfter:Int?,
    val expectedProfit:Long?,
    val risk:String,
    val blocked:String?,
    val nextStep:String
)

data class PlanCandidate(
    val action:String,
    val title:String,
    val reason:String,
    val forecast:PlanForecast,
    val score:Int
)

object DecisionPlanner {
    fun plan(c:android.content.Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):List<PlanCandidate> {
        val s=text.lowercase()
        val phase=when {
            s.contains("аукцион")||s.contains("ставк")->"АУКЦИОН"
            s.contains("продаж")||s.contains("продан")||s.contains("выставить")->"ПРОДАЖА"
            s.contains("покуп")||s.contains("купить")->"ПОКУПКА"
            s.contains("осмотр")||s.contains("автотек")||s.contains("толщиномер")->"ПРОВЕРКА"
            s.contains("ремонт")||s.contains("запчаст")->"РЕМОНТ"
            s.contains("контракт")||s.contains("заказ")->"КОНТРАКТ"
            s.contains("награда")||s.contains("бонус")->"НАГРАДА"
            else->"СВОБОДНАЯ ИГРА"
        }
        val out=mutableListOf<PlanCandidate>()
        val exit=GameParser.exitPrice(text)?:LearningMemory.estimateSalePrice(c,v).price
        val econ=TradeEconomics.calculate(v,exit)
        val deals=CopilotState.deals(c)
        val openDeals=deals.count{it.sell==null}
        val buy=v.price
        if(phase=="НАГРАДА") out += candidate("ПОЛУЧИ","Забери награду","Награда может изменить баланс без покупки машины.",balance,garage,null,"Низкий","Неизвестно","После награды пересчитать бюджет")
        if(phase=="ПРОДАЖА"||openDeals>0) {
            val sell=exit
            val after=sell?.let{(balance?:0L)+it}
            out += candidate("ПРОДАВАЙ","Закрой активную сделку","Продажа освобождает слот и возвращает деньги в оборот.",after,(garage?:0)-1,econ.expectedProfit,"Зависит от фактической цены продажи",null,"После продажи пересчитать бюджет и гараж")
        }
        if(phase=="ПРОДАЖА"||openDeals>0) {
            val roi = LearningMemory.actionRoiStats(c,v).filter { it.samples >= 1 && it.roi > 0 }
            if(roi.isNotEmpty()) {
                val best = roi.maxBy { it.roi }
                out += candidate(
                    "ПОДГОТОВЬ",
                    "Перед продажей проверь окупаемость " + best.action.lowercase(),
                    "По истории этой машины/номера медианный ROI действия: +" + fmt(best.roi) + " ₽ при затратах " + fmt(best.cost) + " ₽ и приросте предложения " + fmtSigned(best.priceDelta) + " ₽.",
                    balance, garage, best.roi, "Исторические данные, N=" + best.samples, null,
                    "Сравнить действие с текущим предложением и только затем применять"
                )
            }
        }
        if(phase=="ПРОВЕРКА"||phase=="РЕМОНТ") {
            out += candidate(if(phase=="РЕМОНТ")"ЗАВЕРШИ" else "ПРОВЕРЯЙ",if(phase=="РЕМОНТ")"Заверши ремонт" else "Дождись проверки","Сначала закрываем неопределённость или обязательный этап текущей сделки.",balance,garage,econ.expectedProfit,"Есть незавершённый этап",null,"Пересчитать экономику после результата")
        }
        if(phase=="АУКЦИОН"&&buy!=null) {
            val can=balance==null||buy<=balance
            out += candidate(if(can)"СТАВЬ" else "НЕ СТАВЬ",if(can)"Сделай ставку только в пределах лимита" else "Не повышай ставку","Цена входа должна оставлять запас бюджета; стартовая ставка не считается покупкой.",if(can)balance?.minus(buy) else balance,garage,econ.expectedProfit,"Аукционная цена может вырасти",null,"После ставки повторно оценить цену входа")
        }
        if(phase=="ПОКУПКА"&&buy!=null) {
            val canPay=balance==null||buy<=balance
            val slot=garage==null||garage<3
            val positive=econ.expectedProfit?.let{it>0}==true
            val action=if(!canPay||!slot)"НЕ ПОКУПАЙ" else if(positive)"ПОКУПАЙ" else "ПРОВЕРЯЙ"
            out += candidate(action,if(action=="ПОКУПАЙ")"Покупка укладывается в текущие ограничения" else if(action=="НЕ ПОКУПАЙ")"Сначала реши ограничение" else "Сначала уточни экономику","Учитываю бюджет, гараж, ожидаемый выход и известные расходы.",if(canPay)balance?.minus(buy) else balance,if(slot)(garage?:0)+1 else garage,econ.expectedProfit,if(!slot)"Нет свободного места" else if(!canPay)"Не хватает бюджета" else if(!positive)"Прибыль не подтверждена" else "Основные ограничения пройдены",null,if(positive)"После покупки: проверки → расходы → продажа" else "После уточнения: повторный расчёт")
        }
        if(phase=="КОНТРАКТ") out += candidate("ПРОВЕРЬ","Проверь условия контракта","Контракт может изменить допустимый автомобиль и бонус сделки.",balance,garage,econ.expectedProfit,"Условия ещё не подтверждены",null,"После проверки сравнить контракт с текущим активом")
        if(out.isEmpty()) {
            val next=if(openDeals>0)"Продолжить текущую сделку" else "Дождаться значимого события"
            out += candidate(if(openDeals>0)"ЗАВЕРШИ" else "НАБЛЮДАЙ",if(openDeals>0)"Сначала доведи текущую сделку до результата" else "Наблюдай и собирай данные","Нет достаточных данных для безопасного изменения состояния.",balance,garage,econ.expectedProfit,"Недостаточно данных",null,next)
        }
        return out.sortedByDescending{it.score}
    }

    fun primary(c:android.content.Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):PlanCandidate=plan(c,text,v,balance,garage).first()

    private fun fmt(n:Long):String = "%,d".format(n).replace(',', ' ')
    private fun fmtSigned(n:Long):String = (if(n>=0) "+" else "") + fmt(n)

    private fun candidate(action:String,title:String,reason:String,balance:Long?,garage:Int?,profit:Long?,risk:String,blocked:String?,next:String)=PlanCandidate(action,title,reason,PlanForecast(balance,garage?.coerceIn(0,3),profit,risk,blocked,next),score(action,profit,risk,blocked))

    private fun score(action:String,profit:Long?,risk:String,blocked:String?):Int {
        var x=50
        if(action=="НЕ ПОКУПАЙ"||action=="НЕ СТАВЬ") x+=25
        if(action=="ПОКУПАЙ"||action=="ПРОДАВАЙ") x+=10
        if(profit!=null&&profit>0) x+=15
        if(profit!=null&&profit<0) x-=20
        if(blocked!=null) x-=10
        if(risk.contains("Неизвестно")||risk.contains("Недостаточно")) x-=5
        return x.coerceIn(0,99)
    }
}
