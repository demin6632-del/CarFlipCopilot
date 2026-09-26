package com.carflip.copilot
import android.content.Context
data class DecisionSignal(val action:String,val title:String,val reason:String,val score:Double,val confidence:Int)
object DecisionEngine {
 fun decide(c:Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):DecisionSignal {
  val opp=OpportunityAnalyzer.analyze(c,text,v,balance,garage); val f=CopilotState.dealForecast(c,v)
  val profit=if(f.has("expected_profit"))f.optLong("expected_profit")else 0L; val roi=if(f.has("roi_percent"))f.optDouble("roi_percent")else 0.0
  val candidates=mutableListOf<DecisionSignal>(); candidates.add(DecisionSignal(opp.action,opp.title,opp.reason,opp.confidence.toDouble(),opp.confidence))
  if(profit>0)candidates.add(DecisionSignal("ПРОДАЖА","Положительный прогноз","Ожидаемая прибыль: "+profit+" ₽; ROI "+String.format("%.1f",roi)+"%.",50+roi.coerceIn(0.0,40.0),(60+roi.coerceIn(0.0,35.0)).toInt()))
  if(profit<=0&&v.name.isNotBlank())candidates.add(DecisionSignal("СТОП","Не увеличивай вложения","Текущий прогноз не показывает положительной ожидаемой прибыли.",75.0,75))
  if(CopilotState.buyerOffers(c,v.plate).isNotEmpty())candidates.add(DecisionSignal("ТОРГ","Есть история предложений","Сравни сохранённые предложения с себестоимостью перед расходами.",82.0,82))
  return candidates.maxByOrNull{it.score}?:DecisionSignal("НАБЛЮДАЮ","Ищу возможность","Обновляю состояние игры в realtime.",40.0,40)
 }
}