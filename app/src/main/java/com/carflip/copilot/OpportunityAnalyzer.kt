package com.carflip.copilot

data class Opportunity(val action:String,val title:String,val reason:String,val confidence:Int=0)
object OpportunityAnalyzer{
 fun analyze(context:android.content.Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):Opportunity{
  val s=text.lowercase();val price=v.price;val hp=v.hp;val painted=v.paintedParts;val hasCar=v.name.isNotBlank()||price!=null||hp!=null||v.plate.isNotBlank();val learned=if(hasCar)LearningMemory.score(context,v)else 0;val offers=CopilotState.buyerOffers(context,v.plate)
  if(offers.isNotEmpty())return Opportunity("ТОРГ","Есть история предложений","Есть сохранённые предложения покупателей. Сравни их с себестоимостью и расходами.",88)
  if(s.contains("награда")||s.contains("бонус"))return Opportunity("ПОЛУЧИ","Есть награда/бонус","Проверь условия награды.",85)
  if(s.contains("контракт")||s.contains("заказ"))return Opportunity("ПРОВЕРЬ","Новый контракт","Сравни требования контракта с машиной.",80)
  if(s.contains("аукцион")||s.contains("ставк")){
   if(v.plate.isNotBlank()){val a=CopilotState.plateAuction(context,v.plate);val bid=CopilotState.plateBestBid(context,v.plate);val cost=CopilotState.plateCost(context,v.plate);val fees=a.optLong("fees",0);val hist=PlateLearning.averageRoi(context,v.plate);val n=PlateLearning.historyCount(context,v.plate)
    if(bid!=null&&cost!=null&&cost>0){val net=bid-cost-fees;val roi=net.toDouble()/cost*100;val h=if(n>0)" История: $n продаж, средний ROI "+String.format("%.1f",hist?:0.0)+"%." else " Истории пока нет.";return if(roi<0)Opportunity("НЕ ПОВЫШАЙ","Ставка убыточна","Номер: $bid ₽; себестоимость: $cost ₽; комиссия: $fees ₽; ROI: "+String.format("%.1f",roi)+"%. Машина не участвует."+h,93) else Opportunity("ЖДИ","Аукцион номера","Номер: $bid ₽; чистый результат: $net ₽; ROI: "+String.format("%.1f",roi)+"%. Машина не участвует."+h,86)}
    return Opportunity("АУКЦИОН","Проверь номер","Аукционная активность есть, но себестоимость ещё не подтверждена.",80)}
   return Opportunity("ПРОВЕРЬ","Аукцион","Проверяю цену входа и прибыль.",70)}
  if(s.contains("продать")||s.contains("продаж")||s.contains("выставить"))return Opportunity("ПРОДАВАЙ","Есть возможность продажи","Проверяю цену продажи и текущую сделку.",82)
  if(s.contains("осмотр")||s.contains("автотека")||s.contains("толщиномер"))return Opportunity("ПРОВЕРЬ","Проверка автомобиля","Проверка может изменить решение о покупке.",78)
  if(hasCar){
   if(price!=null&&balance!=null&&price>balance)return Opportunity("НЕ ПОКУПАЙ","Не хватает денег","Цена выше доступного баланса.",98)
   if(garage!=null&&garage>=3)return Opportunity("НЕ ПОКУПАЙ","Гараж заполнен","Сначала освободи место или продай машину.",98)
   if(price!=null&&price>2500000L)return Opportunity("НЕ ПОКУПАЙ","Выше лимита","Цена превышает лимит 2 500 000 ₽ текущего контракта.",99)
   if(hp!=null&&hp<300)return Opportunity("НЕ ПОКУПАЙ","Не подходит по мощности","Текущий контракт требует минимум 300 л.с.",99)
   if(painted!=null&&painted>99)return Opportunity("НЕ ПОКУПАЙ","Слишком много окраса","Текущий контракт допускает максимум 99 окрашенных деталей.",99)
   if(price!=null&&hp!=null&&price<=2500000L&&hp>=300&&v.origin=="USA"&&(painted==null||painted<=99)){val bonus=learned;return Opportunity("ПОКУПАЙ","Кандидат под контракт","USA + минимум 300 л.с. + цена до 2,5 млн + допустимый окрас. История ИИ: "+(if(bonus>=0)"+" else "")+bonus+".",(96+bonus).coerceIn(70,99))}
   if(price!=null||hp!=null||v.origin.isNotBlank())return Opportunity("ПРОВЕРЯЙ","Недостаточно данных","Досмотри карточку. История ИИ: "+(if(learned>=0)"+" else "")+learned+".",(72+learned).coerceIn(50,95))
  }
  return Opportunity("НАБЛЮДАЮ","Ищу возможность","Слежу за экраном и обновляю сигнал realtime.",40)
 }
}