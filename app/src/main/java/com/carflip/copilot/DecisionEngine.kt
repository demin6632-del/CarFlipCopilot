package com.carflip.copilot

import android.content.Context

data class DecisionSignal(val action:String,val title:String,val reason:String,val score:Double,val confidence:Int)

object DecisionEngine {
    fun decide(c:Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):DecisionSignal {
        val opp=OpportunityAnalyzer.analyze(c,text,v,balance,garage)
        val f=CopilotState.dealForecast(c,v)
        val profit=if(f.has("expected_profit"))f.optLong("expected_profit")else 0L
        val roi=if(f.has("roi_percent")&&!f.isNull("roi_percent"))f.optDouble("roi_percent")else 0.0
        val options=ActionDecisionEngine.evaluate(c,v)
        val best=ActionDecisionEngine.best(c,v)
        val candidates=mutableListOf<DecisionSignal>()
        candidates.add(DecisionSignal(opp.action,opp.title,opp.reason,opp.confidence.toDouble(),opp.confidence))
        if(profit>0)candidates.add(DecisionSignal("ПРОДАЖА","Положительный прогноз","Ожидаемая прибыль: "+profit+" ₽; ROI "+String.format("%.1f",roi)+"%.",50+roi.coerceIn(0.0,40.0),(60+roi.coerceIn(0.0,35.0)).toInt()))
        if(profit<=0&&v.name.isNotBlank())candidates.add(DecisionSignal("СТОП","Не увеличивай вложения","Текущий прогноз не показывает положительной ожидаемой прибыли.",75.0,75))
        if(best.action!="НИЧЕГО НЕ ДЕЛАТЬ"&&best.roi!=null&&best.roi>0){
            val score=(45.0+ActionDecisionEngine.score(best)).coerceIn(45.0,92.0)
            candidates.add(DecisionSignal(best.action,"Действие с подтверждённым ROI",best.reason+" ROI "+String.format("%.1f",best.roi)+"%; выбор учитывает уверенность "+best.confidence+"%.",score,best.confidence))
        }
        options.firstOrNull{it.action=="НИЧЕГО НЕ ДЕЛАТЬ"}?.let{candidates.add(DecisionSignal("НИЧЕГО НЕ ДЕЛАТЬ","Базовый сценарий",it.reason,42.0,it.confidence))}
        if(CopilotState.buyerOffers(c,v.plate).isNotEmpty())candidates.add(DecisionSignal("ТОРГ","Есть история предложений","Сравни сохранённые предложения с себестоимостью перед расходами.",82.0,82))

        if(v.plate.isNotBlank()){
            val auction=CopilotState.plateAuction(c,v.plate)
            val status=auction.optString("status","")
            val bestBid=CopilotState.plateBestBid(c,v.plate)
            val hasAuction=GameParser.plateAuction(text)||status=="OPEN"||status=="LIVE"
            val sold=plateSold(status)
            if(sold){
                candidates.add(DecisionSignal("НОМЕР ПРОДАН","Аукцион номера завершён","Номер "+v.plate+" уже зафиксирован как проданный отдельно.",96.0,96))
            }else if(hasAuction&&bestBid!=null){
                candidates.add(DecisionSignal("ЖДАТЬ СТАВКУ","Аукцион номера активен","Текущая лучшая ставка за номер "+bestBid+" ₽. Машина на аукционе не рассматривается.",90.0,88))
            }else if(hasAuction){
                candidates.add(DecisionSignal("АУКЦИОН НОМЕРА","Аукцион доступен","Выставлять можно только номер "+v.plate+"; автомобиль в аукционное решение не включается.",86.0,82))
            }else if(bestBid!=null||CopilotState.plateValue(c,v.plate)!=null){
                val value=bestBid?:CopilotState.plateValue(c,v.plate)!!
                candidates.add(DecisionSignal("ПРОДАТЬ НОМЕР","Есть отдельная ценность номера","Наблюдаемая цена/ставка номера: "+value+" ₽. Номер учитывается отдельно от сделки автомобиля.",84.0,80))
            }
        }
        return candidates.maxByOrNull{it.score}?:DecisionSignal("НАБЛЮДАЮ","Ищу возможность","Обновляю состояние игры в realtime.",40.0,40)
    }
    private fun plateSold(status:String)=status=="SOLD"||status=="ПРОДАН"
}
