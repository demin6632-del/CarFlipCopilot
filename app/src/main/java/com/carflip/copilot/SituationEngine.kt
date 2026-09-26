package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Holistic game situation memory: keeps a short event timeline and learns outcomes. */
data class SituationAdvice(val action:String,val title:String,val reason:String,val alternatives:List<String> = emptyList(),val confidence:Int=0)

object SituationEngine {
 private const val PREF="copilot_situation"
 private const val TIMELINE="timeline"
 private const val PATTERNS="patterns"
 private const val WINDOW=20*60*1000L
 private fun p(c:Context)=c.getSharedPreferences(PREF,Context.MODE_PRIVATE)

 fun observe(c:Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?) {
  val sig=signature(text,v,balance,garage)
  val a=JSONArray(p(c).getString(TIMELINE,"[]"))
  val last=if(a.length()==0)"" else a.optJSONObject(a.length()-1)?.optString("sig") ?: ""
  if(sig!=last){
   a.put(JSONObject().put("sig",sig).put("phase",phase(text)).put("time",System.currentTimeMillis()))
   while(a.length()>120)a.remove(0)
   p(c).edit().putString(TIMELINE,a.toString()).apply()
  }
 }

 fun advise(c:Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):SituationAdvice {
  observe(c,text,v,balance,garage)
  val s=text.lowercase(); val phase=phase(text)
  if((s.contains("награда")||s.contains("бонус"))) return SituationAdvice("ПОЛУЧИ","Сначала забери награду","Это отдельная игровая возможность и не требует решения по машине.",listOf("После награды снова оценить ситуацию"),94)
  if(garage!=null&&garage>=3&&phase=="ПОКУПКА") return SituationAdvice("НЕ ПОКУПАЙ","Сначала освободи место","Гараж заполнен. Сначала заверши или продай текущий актив.",listOf("Продать машину","Завершить текущую сделку"),99)
  if(balance!=null&&v.price!=null&&v.price>balance&&phase=="ПОКУПКА") return SituationAdvice("НЕ ПОКУПАЙ","Не хватает денег","Цена входа выше доступного баланса.",listOf("Продать актив","Получить доход","Пропустить покупку"),99)
  if(phase=="ПРОДАЖА") return SituationAdvice("ПРОДАВАЙ","Заверши текущую сделку","Продажа изменит баланс и освободит ресурс. После неё ситуация будет пересчитана.",listOf("Проверить итоговую прибыль"),91)
  if(phase=="АУКЦИОН") return SituationAdvice("НАБЛЮДАЙ","Сначала оцени весь аукцион","Сопоставляю ставку, бюджет, гараж, характеристики и историю. Стартовую ставку не считаю фактической продажей.",listOf("Не повышать ставку без расчёта","Сравнить с текущими активами"),88)
  if(s.contains("осмотр")||s.contains("автотека")||s.contains("толщиномер")) return SituationAdvice("ПРОВЕРЯЙ","Не принимай решение до проверки","Результат проверки может изменить расходы, риск и итог сделки.",listOf("Дождаться результата","Пересчитать экономику"),90)
  if(phase=="РЕМОНТ") return SituationAdvice("ЗАВЕРШИ","Учти ремонт перед следующим шагом","Ремонт влияет на себестоимость и должен попасть в расчёт до продажи или следующей покупки.",listOf("Дождаться ремонта","Пересчитать расходы"),87)
  if(phase=="КОНТРАКТ") return SituationAdvice("ПРОВЕРЬ","Сверь условия контракта","Контракт влияет на допустимые действия и бонус, поэтому анализирую его вместе с текущей ситуацией.",listOf("Проверить требования","Сопоставить с бюджетом и гаражом"),89)
  val recent=recentPhases(c)
  if(recent.contains("ПОКУПКА")&&!recent.contains("ПРОДАЖА")&&recent.contains("СВОБОДНАЯ ИГРА")) return SituationAdvice("ЗАВЕРШИ","Сначала доведи текущую сделку до результата","В текущей сессии уже была покупка. Не предлагаю следующую сделку, пока первая не получила результат.",listOf("Проверить состояние","Продать","Учесть расходы"),86)
  if(v.price!=null){
   val exit=GameParser.exitPrice(text)?:LearningMemory.estimateSalePrice(c,v).price
   val e=TradeEconomics.calculate(v,exit)
   if(e.expectedProfit!=null&&e.expectedProfit>0) return SituationAdvice("ПОКУПАЙ","Экономика положительная","Вход, ожидаемый выход и известные расходы дают положительный результат. Контекст тоже учитывается.",listOf("Проверить состояние","Не превышать бюджет"),90)
  }
  return SituationAdvice("ПРОВЕРЯЙ","Собираю полную ситуацию","Слежу не только за машиной: события, деньги, гараж, контракты, награды, проверки и последовательность действий.",listOf("Дождаться следующего события","Проверить активную сделку"),70)
 }

 fun learnOutcome(c:Context,outcome:Long){
  val a=JSONArray(p(c).getString(TIMELINE,"[]"));val now=System.currentTimeMillis();val w=JSONObject(p(c).getString(PATTERNS,"{}"));
  for(i in a.length()-1 downTo 0){val o=a.optJSONObject(i)?:continue;if(now-o.optLong("time",now)>WINDOW)break;val k=o.optString("sig");if(k.isBlank())continue;val old=w.optDouble(k,0.0);val r=if(outcome>0)1.0 else if(outcome<0)-1.0 else 0.0;w.put(k,(old*0.85+r*0.15).coerceIn(-1.0,1.0))}
  p(c).edit().putString(PATTERNS,w.toString()).apply()
 }

 private fun recentPhases(c:Context):List<String>{val a=JSONArray(p(c).getString(TIMELINE,"[]"));val now=System.currentTimeMillis();val out=mutableListOf<String>();for(i in a.length()-1 downTo 0){val o=a.optJSONObject(i)?:continue;if(now-o.optLong("time",now)>WINDOW)break;val x=o.optString("phase");if(x.isNotBlank()&&!out.contains(x))out.add(x)}return out}
 private fun phase(t:String):String{val s=t.lowercase();return when{ s.contains("аукцион")||s.contains("ставк")->"АУКЦИОН";s.contains("продаж")||s.contains("продан")||s.contains("выставить")->"ПРОДАЖА";s.contains("покуп")||s.contains("купить")->"ПОКУПКА";s.contains("осмотр")||s.contains("автотек")||s.contains("толщиномер")->"ПРОВЕРКА";s.contains("ремонт")||s.contains("запчаст")->"РЕМОНТ";s.contains("контракт")||s.contains("заказ")->"КОНТРАКТ";s.contains("награда")||s.contains("бонус")->"НАГРАДА";else->"СВОБОДНАЯ ИГРА"}}
 private fun signature(t:String,v:VehicleSnapshot,b:Long?,g:Int?):String{val m=when{b==null->"NO_BAL";v.price==null->"NO_PRICE";v.price<=b->"CAN_PAY";else->"CANNOT_PAY"};return listOf(phase(t),m,g?:-1,if(v.name.isBlank())"NO_CAR" else "CAR").joinToString("|")}
}
