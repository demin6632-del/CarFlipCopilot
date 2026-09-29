package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

data class PlanDecision(val action:String,val title:String,val reason:String,val confidence:Int,val steps:List<String>,val evidence:List<String> = emptyList())

object GamePlanner {
 private fun norm(s:String)=s.lowercase().replace('ё','е').replace(Regex("\\s+")," ").trim()
 private fun deps(m:JSONObject):List<JSONObject>{
  val a=m.optJSONArray("sequences")?:JSONArray()
  return (0 until a.length()).mapNotNull{a.optJSONObject(it)}.filter{it.optString("status")=="DEPENDENCY_CONFIRMED"}.sortedByDescending{it.optInt("confirmations",0)}
 }
 private fun offerPlan(c:Context,v:VehicleSnapshot):PlanDecision?{
  val offers=CopilotState.buyerOffers(c,v.plate)
  if(v.name.isBlank()||offers.isEmpty())return null
  return PlanDecision("ПРОВЕРЬ_ПРЕДЛОЖЕНИЕ","Проверь предложение покупателя","Есть сохранённое предложение по текущей машине. Сначала проверь актуальную сумму и сравни её с подтверждёнными затратами и результатами прошлых сделок.",84,listOf("Открой актуальное предложение","Сверь сумму с фактическими затратами","Если сумма изменилась — пересчитай решение"),listOf(offers.first()))
 }
 fun plan(c:Context,text:String=""):PlanDecision{
  val balance=CopilotState.balance(c);val garage=CopilotState.garage(c);val vehicle=CopilotState.snapshot(c);val mechanics=GameMechanics.snapshot(c);val confirmed=deps(mechanics);val lower=norm(text);val hasCar=vehicle.name.isNotBlank()
  val offer=offerPlan(c,vehicle)
  if(offer!=null&&(lower.contains("предлож")||lower.contains("покупател")||lower.contains("продаж")||lower.isBlank()))return offer
  val forecast=try{JSONObject(CopilotState.forecast(c))}catch(_:Exception){JSONObject()}
  val profit=if(forecast.has("expected_profit"))forecast.optLong("expected_profit")else null
  val roi=if(forecast.has("roi_percent"))forecast.optDouble("roi_percent")else null
  if(hasCar&&profit!=null&&profit>0){
   val conf=min(88,max(68,forecast.optInt("confidence",72)))
   val roiText=if(roi!=null)" ROI="+String.format("%.1f",roi)+"%" else ""
   return PlanDecision("ГОТОВЬ_К_ПРОДАЖЕ","Подготовь текущую машину к продаже","Последний расчёт показывает положительную прибыль: "+profit+" ₽."+roiText+" Не добавляй неподтверждённые расходы.",conf,listOf("Проверь состояние и обязательные расходы","Не покупай улучшения без подтверждённой отдачи","После нового предложения пересчитай прибыль"),listOf("expected_profit="+profit+" ₽"))
  }
  if(hasCar&&profit!=null&&profit<=0)return PlanDecision("НЕ ПОКУПАЙ_РАСХОДЫ","Не увеличивай вложения в эту машину","Последний расчёт не показывает положительной прибыли. Сначала получи новое предложение или новое подтверждение цены/затрат.",82,listOf("Не добавляй необязательные расходы","Проверь новое предложение покупателя","Пересчитай сделку после изменения данных"),listOf("expected_profit="+profit+" ₽"))
  if(garage>=3)return PlanDecision("ОСВОБОДИ_ГАРАЖ","Сначала освободи место","Гараж заполнен: новая покупка может быть недоступна до освобождения слота.",91,listOf("Проверь все машины в гараже","Выбери действие с подтверждённым результатом","После освобождения места пересчитай рынок"),listOf("garage=3/3"))
  if(balance!=null&&balance>0&&!hasCar){
   val market=MarketAnalyzer.best(c)
   if(market!=null&&market.price<=balance){
    val profit=market.expectedProfit?:0L
    val roi=market.roi?:0.0
    val risk=market.risk
    return PlanDecision("КУПИ_ОБЪЕКТ","Нашёл конкретную машину для покупки","Рынок накоплен из распознанных объявлений. "+market.name+" за "+market.price+" ₽; ожидаемая цена продажи "+(market.expectedSale?:0L)+" ₽; расчётная прибыль "+profit+" ₽; ROI "+String.format("%.1f",roi)+"%; риск "+risk+"/100; заморожено "+capital+" ₽ ("+String.format("%.1f",utilization)+"% капитала)."+turnoverText,min(92,max(65,market.confidence)),listOf("Открой карточку "+market.name,"Проверь актуальную цену "+market.price+" ₽","Перед покупкой сверяй состояние и дополнительные расходы"),listOf("market_candidate="+market.name,"expected_profit="+profit+" ₽","roi="+String.format("%.1f",roi)+"%","risk="+risk+"/100","capital_locked="+capital+" ₽","capital_utilization="+String.format("%.1f",utilization)+"%","holding_days="+(turnover?.toString()?:"unknown")))
   }
   val edge=confirmed.firstOrNull()
   val reason=if(edge==null)"Свободный гараж и известный текущий капитал. Нужны свежие данные рынка, прежде чем выбирать объект." else "Свободный гараж и капитал. Подтверждена повторяющаяся цепочка "+edge.optString("from")+" → "+edge.optString("to")+"."
   return PlanDecision("ИЩИ_СЛЕДУЮЩИЙ_ОБЪЕКТ","Открой актуальный рынок",reason,min(86,60+confirmed.size*4),listOf("Открой рынок/список доступных машин","Дождись свежих цены и характеристик","После распознавания посчитай прибыль, риск и замороженный капитал"),if(edge==null)emptyList()else listOf("confirmed_dependencies="+confirmed.size))
  }
  if(confirmed.isNotEmpty()){
   val edge=confirmed.first()
   return PlanDecision("ПРОДОЛЖИ_ЦЕПОЧКУ","Продолжи подтверждённую цепочку","Журнал подтвердил повторяющуюся последовательность "+edge.optString("from")+" → "+edge.optString("to")+".",min(92,62+edge.optInt("confirmations",2)*3),listOf("Выполни следующий наблюдаемый шаг","Дождись изменения состояния","Проверь фактический результат перед следующим действием"),listOf("confirmations="+edge.optInt("confirmations",0)))
  }
  return PlanDecision("НАБЛЮДАЙ","Сначала собери состояние игры","Пока недостаточно свежих подтверждённых данных для уверенного действия.",45,listOf("Оставь мониторинг включённым","Открой актуальный экран игры","Дождись нового подтверждённого события"))
 }
 fun snapshot(c:Context,text:String="")=plan(c,text).let{JSONObject().put("action",it.action).put("title",it.title).put("reason",it.reason).put("confidence",it.confidence).put("steps",JSONArray(it.steps)).put("evidence",JSONArray(it.evidence)).put("source","local_evidence_planner")}
}