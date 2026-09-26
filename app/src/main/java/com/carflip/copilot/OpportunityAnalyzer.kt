package com.carflip.copilot

data class Opportunity(val action:String,val title:String,val reason:String,val confidence:Int=0)

object OpportunityAnalyzer {
 fun analyze(context:android.content.Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):Opportunity {
  val s=text.lowercase(); val hasCar=v.name.isNotBlank()||v.price!=null||v.hp!=null||v.plate.isNotBlank(); val learned=if(hasCar) LearningMemory.score(context,v) else 0
  val observedExit=GameParser.exitPrice(text)
  val learnedExit=if(observedExit==null) LearningMemory.estimateSalePrice(context,v) else SalePriceEstimate(observedExit,0,100)
  val e=TradeEconomics.calculate(v,learnedExit.price)
  if(s.contains("награда")||s.contains("награду")||s.contains("бонус")) return Opportunity("ПОЛУЧИ","Есть награда/бонус","Проверь условия и забери, если доступно.",85)
  if(s.contains("контракт")||s.contains("заказ")) return Opportunity("ПРОВЕРЬ","Новый контракт",TradeEconomics.summary(v),80)
  if(s.contains("аукцион")||s.contains("ставк")) return if(v.plate.isNotBlank()) Opportunity("АУКЦИОН","Проверь номер","Есть аукционная активность. Стартовую цену не считаю фактической продажей.",80) else Opportunity("ПРОВЕРЬ","Аукцион",TradeEconomics.summary(v),70)
  if(s.contains("продать")||s.contains("продаж")||s.contains("выставить")) return Opportunity("ПРОДАВАЙ","Есть возможность продажи","Цена выхода должна быть подтверждена экраном; без неё прибыль не оцениваю.",82)
  if(s.contains("осмотр")||s.contains("автотека")||s.contains("толщиномер")) return Opportunity("ПРОВЕРЬ","Проверка автомобиля","Проверка может изменить себестоимость и решение о покупке.",78)
  if(hasCar){
   if(v.price!=null&&balance!=null&&v.price>balance) return Opportunity("НЕ ПОКУПАЙ","Не хватает денег","Цена входа выше доступного баланса.",98)
   if(garage!=null&&garage>=3) return Opportunity("НЕ ПОКУПАЙ","Гараж заполнен","Сначала освободи место или продай машину.",98)
   if(v.price!=null&&v.price>TradeEconomics.kinoProducer.maxPurchasePrice) return Opportunity("НЕ ПОКУПАЙ","Цена выше лимита","Цена входа превышает лимит контракта 2 500 000 ₽.",99)
   if(v.hp!=null&&v.hp<TradeEconomics.kinoProducer.minHp) return Opportunity("НЕ ПОКУПАЙ","Не подходит по мощности","Контракт требует минимум 300 л.с.",99)
   if(v.paintedParts!=null&&v.paintedParts>TradeEconomics.kinoProducer.maxPaintedParts) return Opportunity("НЕ ПОКУПАЙ","Слишком много окраса","Контракт допускает максимум 99 крашеных деталей.",99)
   if(e.contractEligible){
    if(learnedExit.price==null) return Opportunity("ПРОВЕРЯЙ","Цена выхода неизвестна","Кандидат проходит контракт, но нет подтверждённой цены продажи и нет истории для оценки. Покупку не подтверждаю.",78)
    if((e.expectedProfit ?: Long.MIN_VALUE)<=0L) return Opportunity("НЕ ПОКУПАЙ","Ожидаемая прибыль ≤ 0","Выход: ${fmt(learnedExit.price)} ₽ • себестоимость: ${fmt(e.totalKnownCosts)} ₽ • бонус: +${fmt(e.contractBonus)} ₽.",94)
    val source=if(observedExit!=null)"экран" else "история сделок"
    return Opportunity("ПОКУПАЙ","Кандидат с положительной экономикой","Выход: ${fmt(learnedExit.price)} ₽ • прибыль: +${fmt(e.expectedProfit ?: 0L)} ₽ • источник: $source.",(92+learned).coerceIn(70,99))
   }
   if(v.price!=null||v.hp!=null||v.origin.isNotBlank()||v.paintedParts!=null) return Opportunity("ПРОВЕРЯЙ","Недостаточно данных",e.contractMissing.joinToString(prefix="Не подтверждено: ").ifBlank{"Досмотри карточку автомобиля перед покупкой."},(72+learned).coerceIn(50,95))
  }
  return Opportunity("НАБЛЮДАЮ","Ищу возможность","Слежу за экраном и обновляю сигнал при изменении ситуации.",40)
 private fun fmt(v:Long)="%,d".format(v).replace(',',' ')
 }
}
