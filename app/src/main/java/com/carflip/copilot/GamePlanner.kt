package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max

data class PlanDecision(val action:String,val title:String,val reason:String,val confidence:Int,val steps:List<String>)

object GamePlanner {
 private fun norm(s:String)=s.lowercase().replace('ё','е').replace(Regex("\\s+")," ").trim()
 fun plan(c:Context,text:String=""):PlanDecision {
  val balance=CopilotState.balance(c); val garage=CopilotState.garage(c); val vehicle=CopilotState.snapshot(c)
  val mechanics=GameMechanics.snapshot(c); val deps=try{mechanics.optJSONArray("sequences")?:JSONArray()}catch(_:Exception){JSONArray()}
  val confirmed=(0 until deps.length()).mapNotNull{deps.optJSONObject(it)}.filter{it.optString("status")=="DEPENDENCY_CONFIRMED"}
  val lower=norm(text); val hasCar=vehicle.name.isNotBlank(); val hasOffer=CopilotState.buyerOffers(c,vehicle.plate).isNotEmpty()
  val expectedProfit=try{JSONObject(CopilotState.forecast(c)).optLong("expected_profit",Long.MIN_VALUE).takeIf{it!=Long.MIN_VALUE}}catch(_:Exception){null}
  if(hasCar&&hasOffer&&(lower.contains("предлож")||lower.contains("покупател")||lower.contains("продаж"))) return PlanDecision("ПРОВЕРЬ_ПРЕДЛОЖЕНИЕ","Проверь актуальное предложение покупателя","Есть реальное предложение по текущей машине. Сначала сравни его с подтверждённой историей и ожидаемым результатом сделки.",78,listOf("Открой актуальное предложение","Сравни сумму с сохранёнными предложениями","После изменения предложения пересчитай решение"))
  if(hasCar&&expectedProfit!=null&&expectedProfit>0) return PlanDecision("ГОТОВЬ_К_ПРОДАЖЕ","Подготовь текущую машину к продаже","По сохранённым данным ожидается положительный результат сделки. Не добавляй расходы, которые ещё не подтверждены.",72,listOf("Проверь состояние и расходы","Не запускай неподтверждённые улучшения","Выбери подтверждённое окно продажи"))
  if(garage>=3) return PlanDecision("ОСВОБОДИ_ГАРАЖ","Сначала освободи место","Гараж заполнен, поэтому следующая покупка может быть заблокирована.",88,listOf("Проверь машины в гараже","Выбери действие с лучшим подтверждённым результатом","После освобождения места пересчитай план"))
  if(balance!=null&&balance>0&&!hasCar){ val ct=confirmed.take(3).joinToString("; "){it.optString("from")+" -> "+it.optString("to")}; val reason=if(ct.isBlank())"Свободный гараж и известный капитал. Сначала получи актуальный объект, не придумывая цену." else "Есть свободный гараж и подтверждённые игровые цепочки: "+ct; return PlanDecision("ИЩИ_СЛЕДУЮЩИЙ_ОБЪЕКТ","Открой актуальный рынок",reason,max(55,minOf(82,55+confirmed.size*5)),listOf("Открой рынок/список доступных объектов","Дождись свежих цен и характеристик","После распознавания пересчитай прибыль и риск")) }
  if(confirmed.isNotEmpty()){ val edge=confirmed.maxByOrNull{it.optInt("confirmations",0)}!!; return PlanDecision("ПРОДОЛЖИ_ЦЕПОЧКУ","Продолжи подтверждённую цепочку","Игровой журнал уже подтвердил повторяющуюся последовательность: "+edge.optString("from")+" → "+edge.optString("to")+".",minOf(90,60+edge.optInt("confirmations",2)*3),listOf("Выполни следующий наблюдаемый шаг","Дождись изменения состояния","Проверь результат перед следующим действием")) }
  return PlanDecision("НАБЛЮДАЙ","Сначала собери состояние игры","Пока недостаточно свежих подтверждённых данных для безопасного действия.",45,listOf("Оставь мониторинг включённым","Открой актуальный экран игры","Дождись нового подтверждённого события"))
 }
 fun snapshot(c:Context,text:String="")=plan(c,text).let{JSONObject().put("action",it.action).put("title",it.title).put("reason",it.reason).put("confidence",it.confidence).put("steps",JSONArray(it.steps)).put("source","local_evidence_planner")}
}