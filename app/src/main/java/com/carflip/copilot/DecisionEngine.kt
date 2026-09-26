package com.carflip.copilot

import android.content.Context

data class DecisionSignal(val action:String,val title:String,val reason:String,val score:Double,val confidence:Int)

object DecisionEngine {
    fun decide(c:Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):DecisionSignal {
        val opp=OpportunityAnalyzer.analyze(c,text,v,balance,garage)
        val f=CopilotState.dealForecast(c,v)
        val profit=if(f.has("expected_profit"))f.optLong("expected_profit")else 0L
        val roi=if(f.has("roi_percent"))f.optDouble("roi_percent")else 0.0
        val options=ActionDecisionEngine.evaluate(c,v)\n        val plateValue=if(v.plate.isNotBlank())CopilotState.plateValue(c,v.plate) else null\n        val plateOffers=if(v.plate.isNotBlank())CopilotState.plateOffers(c,v.plate) else emptyList()
        val best=ActionDecisionEngine.best(c,v)
        val candidates=mutableListOf<DecisionSignal>()
        candidates.add(DecisionSignal(opp.action,opp.title,opp.reason,opp.confidence.toDouble(),opp.confidence))
        if(profit>0)candidates.add(DecisionSignal("ПРОДАЖА","Положительный прогноз","Ожидаемая прибыль: "+profit+" ₽; ROI "+String.format("%.1f",roi)+"%.",50+roi.coerceIn(0.0,40.0),(60+roi.coerceIn(0.0,35.0)).toInt()))
        if(profit<=0&&v.name.isNotBlank())candidates.add(DecisionSignal("СТОП","Не увеличивай вложения","Текущий прогноз не показывает положительной ожидаемой прибыли.",75.0,75))
        if(best.action!="НИЧЕГО НЕ ДЕЛАТЬ"&&best.roi!=null&&best.roi>0){
            val score=(45.0+ActionDecisionEngine.score(best)).coerceIn(45.0,92.0)
            candidates.add(DecisionSignal(best.action,"Действие с подтверждённым ROI",best.reason+" ROI "+String.format("%.1f",best.roi)+"%; выбор учитывает уверенность "+best.confidence+"%.",score,best.confidence))
        }
        val baseline=options.firstOrNull{it.action=="НИЧЕГО НЕ ДЕЛАТЬ"}
        if(baseline!=null)candidates.add(DecisionSignal("НИЧЕГО НЕ ДЕЛАТЬ","Базовый сценарий",baseline.reason,42.0,baseline.confidence))
        if(CopilotState.buyerOffers(c,v.plate).isNotEmpty())candidates.add(DecisionSignal("ТОРГ","Есть история предложений","Сравни сохранённые предложения с себестоимостью перед расходами.",82.0,82))\n        if(plateOffers.isNotEmpty()||plateValue!=null)candidates.add(DecisionSignal("ПРОДАТЬ НОМЕР","Номер можно продать отдельно", "Номер "+v.plate+" имеет отдельную историю/оценку: "+(plateValue?.let{it.toString()+" ₽"}?:plateOffers.firstOrNull()?:"нет суммы")+" . Сравни отдельную продажу номера с продажей машины с этим номером.",86.0,80))
        return candidates.maxByOrNull{it.score}?:DecisionSignal("НАБЛЮДАЮ","Ищу возможность","Обновляю состояние игры в realtime.",40.0,40)
    }
}
