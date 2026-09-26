package com.carflip.copilot

data class Opportunity(val action:String,val title:String,val reason:String,val confidence:Int=0)

object OpportunityAnalyzer {
 fun analyze(context:android.content.Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):Opportunity {
  val s=text.lowercase()
  val hasCar=v.name.isNotBlank()||v.price!=null||v.hp!=null||v.plate.isNotBlank()
  val phase=when {
   s.contains("аукцион")||s.contains("ставк") -> "AUCTION"
   s.contains("продать")||s.contains("продаж")||s.contains("выставить")||s.contains("продан") -> "SALE"
   s.contains("покуп")||s.contains("купить")||s.contains("осмотр") -> "BUY"
   s.contains("контракт")||s.contains("заказ") -> "CONTRACT"
   s.contains("гараж") -> "GARAGE"
   s.contains("награда")||s.contains("бонус") -> "REWARD"
   else -> "FREE"
  }
  val situationKey=listOf(phase,if(hasCar)"CAR" else "NO_CAR",if(v.price!=null)"PRICE" else "NO_PRICE",if(v.hp!=null)"HP" else "NO_HP",if(v.origin.isNotBlank())v.origin.uppercase() else "NO_ORIGIN",if(v.paintedParts!=null)"PAINT" else "NO_PAINT",when { balance==null -> "NO_BAL"; v.price==null -> "BAL_UNKNOWN"; v.price<=balance -> "CAN_PAY"; else -> "CANNOT_PAY" },when { garage==null -> "GARAGE_UNKNOWN"; garage>=3 -> "FULL"; else -> "SPACE" }).joinToString("|")
  LearningMemory.setCurrentSituation(context,situationKey)
  val learned=(if(hasCar)LearningMemory.score(context,v)else 0)+LearningMemory.situationScore(context)
  val observedExit=GameParser.exitPrice(text)
  val learnedExit=if(observedExit==null)LearningMemory.estimateSalePrice(context,v)else SalePriceEstimate(observedExit,0,100)
  val e=TradeEconomics.calculate(v,learnedExit.price)
  if(s.contains("награда")||s.contains("награду")||s.contains("бонус")) return Opportunity("ПОЛУЧИ","Есть награда/бонус","Учитываю награду как часть общей игровой ситуации.",85)
  if(phase=="SALE") return Opportunity("ПРОДАВАЙ","Ситуация продажи",if(learnedExit.price!=null)"Цена выхода: "+fmt(learnedExit.price)+" ₽ • "+if(observedExit!=null)"подтверждена экраном" else "оценена по истории" else "Цена выхода пока неизвестна. Собираю данные и историю.",if(learnedExit.price!=null)90 else 75)
  if(phase=="AUCTION") return Opportunity("АУКЦИОН","Идёт аукционная ситуация","Сопоставляю номер, характеристики, бюджет, гараж и историю; стартовую ставку не считаю фактической продажей.",80)
  if(phase=="CONTRACT") return Opportunity("ПРОВЕРЬ","Ситуация контракта",TradeEconomics.summary(v)+" Контракт анализируется вместе со всей сделкой.",82)
  if(s.contains("осмотр")||s.contains("автотека")||s.contains("толщиномер")) return Opportunity("ПРОВЕРЬ","Ситуация проверки","Результат проверки может изменить себестоимость, риск и ожидаемую прибыль. После новых данных пересчитаю сделку.",78)
  if(hasCar){
   if(v.price!=null&&balance!=null&&v.price>balance) return Opportunity("НЕ ПОКУПАЙ","Сделка не укладывается в бюджет","Цена входа выше доступного баланса. Решение учитывает всю ситуацию, а не отдельный параметр.",98)
   if(garage!=null&&garage>=3) return Opportunity("НЕ ПОКУПАЙ","Нет места в гараже","Подходящий автомобиль сейчас не помещается. Решение зависит от всей ситуации.",98)
   if(v.price!=null&&v.price>TradeEconomics.kinoProducer.maxPurchasePrice) return Opportunity("НЕ ПОКУПАЙ","Сделка не проходит лимит","Цена входа выше лимита контракта 2 500 000 ₽.",99)
   if(v.hp!=null&&v.hp<TradeEconomics.kinoProducer.minHp) return Opportunity("НЕ ПОКУПАЙ","Сделка не проходит по мощности","Контракт требует минимум 300 л.с.",99)
   if(v.paintedParts!=null&&v.paintedParts>TradeEconomics.kinoProducer.maxPaintedParts) return Opportunity("НЕ ПОКУПАЙ","Сделка не проходит по состоянию","Контракт допускает максимум 99 крашеных деталей.",99)
   if(e.contractEligible){
    if(learnedExit.price==null) return Opportunity("ПРОВЕРЯЙ","Сделка пока не просчитана","Автомобиль подходит по условиям, но цена выхода неизвестна. Собираю полный контекст.",78)
    val profit=e.expectedProfit?:Long.MIN_VALUE
    if(profit<=0L) return Opportunity("НЕ ПОКУПАЙ","Полная экономика отрицательная","Вход: "+fmt(v.price?:0)+" ₽ • выход: "+fmt(learnedExit.price)+" ₽ • ожидаемая прибыль: "+fmt(profit)+" ₽.",94)
    val source=if(observedExit!=null)"экран" else "история сделок"
    return Opportunity("ПОКУПАЙ","Сделка выглядит прибыльной целиком","Вход: "+fmt(v.price?:0)+" ₽ • выход: "+fmt(learnedExit.price)+" ₽ • прибыль: +"+fmt(profit)+" ₽ • цена выхода: "+source+". Обучение учитывает контекст.",(92+learned).coerceIn(70,99))
   }
   if(v.price!=null||v.hp!=null||v.origin.isNotBlank()||v.paintedParts!=null) return Opportunity("ПРОВЕРЯЙ","Собираю полную картину",e.contractMissing.joinToString(prefix="Пока не подтверждено: ").ifBlank{"Собираю цену, характеристики, состояние, бюджет, гараж и условия сделки."},(70+learned).coerceIn(50,95))
  }
  return Opportunity("НАБЛЮДАЮ","Анализирую ситуацию","Слежу за связкой: экран → событие → автомобиль → деньги → гараж → контракт → цена выхода → результат сделки.",(45+learned).coerceIn(30,90))
 }
 private fun fmt(v:Long)="%,d".format(v).replace(',',' ')
}
