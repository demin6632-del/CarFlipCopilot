package com.carflip.copilot

import android.content.Context

object DecisionEngine {
 fun decide(c:Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):Opportunity{
  val base=OpportunityAnalyzer.analyze(c,text,v,balance,garage)
  val f=CopilotState.dealForecast(c,v)
  val profit=if(f.has("expected_profit")&&!f.isNull("expected_profit"))f.optLong("expected_profit")else 0L
  val roi=if(f.has("roi_percent")&&!f.isNull("roi_percent"))f.optDouble("roi_percent")else 0.0
  if(v.plate.isNotBlank()){
   val a=CopilotState.plateAuction(c,v.plate);val bid=CopilotState.plateBestBid(c,v.plate);val cost=CopilotState.plateCost(c,v.plate);val status=a.optString("status","")
   if(status=="SOLD")return Opportunity("НОМЕР ПРОДАН","Аукцион номера завершён","Номер продаётся отдельно от автомобиля.",96)
   if((status=="OPEN"||status=="LIVE"||GameParser.plateAuction(text))&&bid!=null&&cost!=null&&cost>0){val net=bid-cost-a.optLong("fees");val r=net.toDouble()/cost*100;if(r<0)return Opportunity("НЕ ПОВЫШАЙ","Ставка убыточна","Текущая ставка "+bid+" ₽; чистый результат "+net+" ₽; ROI "+String.format("%.1f",r)+"%. Машина на аукционе не участвует.",93);return Opportunity("ЖДИ","Аукцион номера","Текущая ставка "+bid+" ₽; чистый результат "+net+" ₽; ROI "+String.format("%.1f",r)+"%.",86)}
  }
  if(profit>0)return Opportunity("ПРОДАЖА","Положительный прогноз","Ожидаемая прибыль: "+profit+" ₽; ROI "+String.format("%.1f",roi)+"%.",80)
  if(base.action!="НАБЛЮДАЮ")return base
  return if(v.name.isNotBlank())Opportunity("ПРОВЕРЯЙ","Продолжаю анализ","Недостаточно подтверждённых данных для действия.",55)else base
 }
}