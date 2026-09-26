package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class VehicleSnapshot(val name:String="",val price:Long?=null,val hp:Int?=null,val mileage:Long?=null,val owners:Int?=null,val plate:String="",val origin:String="",val paintedParts:Int?=null,val stage:Int?=null,val invested:Long?=null,val polishApplied:Boolean?=null,val raw:String="",val updatedAt:Long=System.currentTimeMillis())
data class LedgerEvent(val type:String,val amount:Long?=null,val note:String="",val time:Long=System.currentTimeMillis())
data class Deal(val id:String,val name:String,val plate:String,val buy:Long?,val sell:Long?,val fees:Long,val opened:Long,val closed:Long?)
data class PlateRecord(val plate:String,val state:String,val value:Long?,val updated:Long)

object CopilotState {
 private const val PREF="copilot_state";private const val INITIAL_BALANCE=8741902L
 private fun p(c:Context)=c.getSharedPreferences(PREF,Context.MODE_PRIVATE)
 fun balance(c:Context)=p(c).getLong("balance",INITIAL_BALANCE)
 fun setBalance(c:Context,v:Long)=p(c).edit().putLong("balance",v).apply()
 fun garage(c:Context)=p(c).getInt("garage",0).coerceIn(0,3)
 fun setGarage(c:Context,v:Int)=p(c).edit().putInt("garage",v.coerceIn(0,3)).apply()
 fun decision(c:Context)=p(c).getString("decision","СМОТРЮ…")?:"СМОТРЮ…"
 fun setDecision(c:Context,v:String)=p(c).edit().putString("decision",v).apply()
 fun monitoring(c:Context)=p(c).getBoolean("monitoring",false)
 fun setMonitoring(c:Context,v:Boolean)=p(c).edit().putBoolean("monitoring",v).apply()
 fun snapshot(c:Context):VehicleSnapshot{
  val s=p(c).getString("vehicle","")?:"";if(s.isEmpty())return VehicleSnapshot()
  return try{val o=JSONObject(s);VehicleSnapshot(o.optString("name"),if(o.has("price"))o.optLong("price")else null,if(o.has("hp"))o.optInt("hp")else null,if(o.has("mileage"))o.optLong("mileage")else null,if(o.has("owners"))o.optInt("owners")else null,o.optString("plate"),o.optString("origin"),if(o.has("paintedParts"))o.optInt("paintedParts")else null,if(o.has("stage"))o.optInt("stage")else null,if(o.has("invested"))o.optLong("invested")else null,if(o.has("polishApplied"))o.optBoolean("polishApplied")else null,o.optString("raw"),o.optLong("updatedAt"))}catch(_:Exception){VehicleSnapshot()}
 }
 fun setSnapshot(c:Context,v:VehicleSnapshot){val o=JSONObject().put("name",v.name).put("plate",v.plate).put("origin",v.origin).put("raw",v.raw.take(8000)).put("updatedAt",v.updatedAt);v.price?.let{o.put("price",it)};v.hp?.let{o.put("hp",it)};v.mileage?.let{o.put("mileage",it)};v.owners?.let{o.put("owners",it)};v.paintedParts?.let{o.put("paintedParts",it)};v.stage?.let{o.put("stage",it)};v.invested?.let{o.put("invested",it)};v.polishApplied?.let{o.put("polishApplied",it)};p(c).edit().putString("vehicle",o.toString()).apply()}
 private fun append(c:Context,keyName:String,obj:JSONObject,max:Int=200){val pref=p(c);val a=JSONArray(pref.getString(keyName,"[]"));val key=obj.optString("key");if(key.isNotEmpty())for(i in 0 until a.length())if(a.optJSONObject(i)?.optString("key")==key)return;a.put(obj);while(a.length()>max)a.remove(0);pref.edit().putString(keyName,a.toString()).apply()}
 fun addEvent(c:Context,text:String){append(c,"events",JSONObject().put("key",text.hashCode().toString()+"|"+System.currentTimeMillis()/5000).put("text",text.take(900)).put("time",System.currentTimeMillis()))}
 fun events(c:Context):List<String>{val a=JSONArray(p(c).getString("events","[]"));return(0 until a.length()).mapNotNull{a.optJSONObject(it)?.optString("text")}.reversed()}
 fun addLedger(c:Context,type:String,amount:Long?,note:String){if(amount==null)return;append(c,"ledger",JSONObject().put("key",(type+"|"+amount+"|"+note).hashCode().toString()).put("type",type).put("amount",amount).put("note",note.take(500)).put("time",System.currentTimeMillis()))}
 fun ledger(c:Context):List<LedgerEvent>{val a=JSONArray(p(c).getString("ledger","[]"));return(0 until a.length()).map{val o=a.getJSONObject(it);LedgerEvent(o.optString("type"),o.optLong("amount"),o.optString("note"),o.optLong("time"))}.reversed()}
 fun recordPurchase(c:Context,v:VehicleSnapshot,amount:Long){val id=(v.plate.ifEmpty{v.name}).ifEmpty{"deal"}+"|"+System.currentTimeMillis();val o=JSONObject().put("id",id).put("name",v.name).put("plate",v.plate).put("buy",amount).put("fees",0L).put("opened",System.currentTimeMillis());append(c,"deals",o);addLedger(c,"ПОКУПКА",-amount,v.name.ifEmpty{"авто"})}
 fun recordSale(c:Context,v:VehicleSnapshot,amount:Long){val a=JSONArray(p(c).getString("deals","[]"));var idx=-1;for(i in a.length()-1 downTo 0){val o=a.optJSONObject(i)?:continue;if(!o.has("sell")&&((v.plate.isNotEmpty()&&o.optString("plate")==v.plate)||(v.plate.isEmpty()&&o.optString("name")==v.name))){idx=i;break}};var learnedProfit:Long?=null;if(idx>=0){val existing=a.getJSONObject(idx);val buy=if(existing.has("buy"))existing.optLong("buy") else 0L;val fees=existing.optLong("fees");learnedProfit=amount-buy-fees;a.put(idx,existing.put("sell",amount).put("closed",System.currentTimeMillis()))}else{a.put(JSONObject().put("id",(v.plate.ifEmpty{v.name})+"|"+System.currentTimeMillis()).put("name",v.name).put("plate",v.plate).put("sell",amount).put("fees",0L).put("opened",System.currentTimeMillis()).put("closed",System.currentTimeMillis()))};while(a.length()>200)a.remove(0);p(c).edit().putString("deals",a.toString()).apply();learnedProfit?.let{LearningMemory.learn(c,v,it,buy,amount);SituationEngine.learnOutcome(c,it);addEvent(c,"ОБУЧЕНИЕ • результат "+it+" ₽ • модель "+v.name)};addLedger(c,"ПРОДАЖА",amount,v.name.ifEmpty{"авто"})}
 fun addFee(c:Context,amount:Long,note:String){val a=JSONArray(p(c).getString("deals","[]"));for(i in a.length()-1 downTo 0){val o=a.optJSONObject(i)?:continue;if(!o.has("closed")){o.put("fees",o.optLong("fees")+amount);break}};p(c).edit().putString("deals",a.toString()).apply();addLedger(c,"РАСХОД",-amount,note)}
 fun setPlate(c:Context,plate:String,state:String,value:Long?=null){if(plate.isBlank())return;val a=JSONArray(p(c).getString("plates","[]"));var idx=-1;for(i in 0 until a.length())if(a.optJSONObject(i)?.optString("plate")==plate){idx=i;break};val o=JSONObject().put("plate",plate).put("state",state).put("updated",System.currentTimeMillis());value?.let{o.put("value",it)};if(idx>=0)a.put(idx,o)else a.put(o);while(a.length()>100)a.remove(0);p(c).edit().putString("plates",a.toString()).apply()}
 fun plates(c:Context):List<PlateRecord>{val a=JSONArray(p(c).getString("plates","[]"));return(0 until a.length()).map{val o=a.getJSONObject(it);PlateRecord(o.optString("plate"),o.optString("state"),if(o.has("value"))o.optLong("value")else null,o.optLong("updated"))}.reversed()}
 fun deals(c:Context):List<Deal>{val a=JSONArray(p(c).getString("deals","[]"));return(0 until a.length()).map{val o=a.getJSONObject(it);Deal(o.optString("id"),o.optString("name"),o.optString("plate"),if(o.has("buy"))o.optLong("buy")else null,if(o.has("sell"))o.optLong("sell")else null,o.optLong("fees"),o.optLong("opened"),if(o.has("closed"))o.optLong("closed")else null)}.reversed()}
}
object GameParser {
 private fun norm(s:String)=s.replace('\u00A0',' ').replace(Regex("[\\t\\r]+")," ")
 private fun num(s:String)=s.replace(" ","").replace("\u00A0","").replace("₽","").replace(",","").toLongOrNull()
 fun balance(t:String):Long?{val re=Regex("(?i)(?:баланс|счет|счёт|наличн|деньг|капитал|кошел)[^\\d]{0,35}(\\d{1,3}(?:[ .]\\d{3}){1,2}|\\d{6,9})");return norm(t).lines().asSequence().mapNotNull{re.find(it)?.groupValues?.getOrNull(1)?.let(::num)}.firstOrNull()}
 fun garage(t:String):Int?=Regex("(?i)(?:гараж|garage)\\s*[:\\-]?\\s*(\\d+)\\s*/\\s*(\\d+)").find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
 private fun contextAmount(t:String,words:String):Long?{val re=Regex("(?i)(?:$words)[^\\d]{0,55}(\\d{1,3}(?:[ .]\\d{3}){1,2}|\\d{6,9})\\s*₽?");return re.find(norm(t))?.groupValues?.get(1)?.let(::num)}
 fun purchaseAmount(t:String)=contextAmount(t,"купил|покупка|покупаешь|покупаю")
 fun saleAmount(t:String)=contextAmount(t,"продал|продажа|продаёшь|продаешь|продаю|выручил|получил")
 fun expenseAmount(t:String)=contextAmount(t,"оплатил|списан|расход|осмотр|автотека|комисси|сняти[ея]|продлить объявление|объявление")
 fun price(t:String):Long?{val s=norm(t);val c=Regex("(?i)(?:цена|стоимость|предлагает|торг|продаёт|продает|купить)[^\\d]{0,30}(\\d{1,3}(?:[ .]\\d{3}){1,2}|\\d{6,9})").find(s);if(c!=null)return c.groupValues[1].let(::num);return Regex("(?<!\\d)(\\d{1,3}(?: \\d{3}){1,2})(?:\\s*₽)").find(s)?.groupValues?.get(1)?.let(::num)}
 fun exitPrice(t:String):Long? {
  val s=norm(t)
  val patterns=listOf(
   "(?i)(?:предложение|цена продажи|цена при продаже|продажная цена|продать за|выставить за|цена выкупа)[^\\d]{0,35}(\\d{1,3}(?:[ .]\\d{3}){1,2}|\\d{6,9})\\s*₽?",
   "(?i)(?:продан|продано|выручка|получил за авто|выручил за авто)[^\\d]{0,35}(\\d{1,3}(?:[ .]\\d{3}){1,2}|\\d{6,9})\\s*₽?"
  )
  for(p in patterns){val m=Regex(p).find(s);if(m!=null)return m.groupValues[1].let(::num)}
  return null
 }
 fun hp(t:String)=Regex("(?<!\\d)(\\d{2,4})\\s*(?:л\\.\\s*с\\.?|лс|hp)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.toIntOrNull()\n fun stage(t:String)=Regex("(?i)\\bStage\\s*(\\d+)").find(norm(t))?.groupValues?.get(1)?.toIntOrNull()\n fun invested(t:String)=Regex("(?i)(?:вложено в проект|вложено)[^\\d]{0,20}(\\d{1,3}(?:[ .]\\d{3}){1,2}|\\d{6,9})").find(norm(t))?.groupValues?.get(1)?.let(::num)
 fun polishApplied(t:String):Boolean?{val s=norm(t).lowercase();return if(s.contains("полировка нанесена: да")) true else if(s.contains("полировка нанесена: нет")) false else null}\n fun mileage(t:String)=Regex("(?<!\\d)(\\d{1,3}(?: \\d{3})+|\\d{5,7})\\s*(?:км|km)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.let(::num)
 fun owners(t:String)=Regex("(\\d+)\\s*(?:владельц|owner)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
 fun plate(t:String)=Regex("\\b[А-ЯA-Z]\\d{3}[А-ЯA-Z]{2}\\s*\\d{2,3}\\b",RegexOption.IGNORE_CASE).find(norm(t))?.value?:""
 fun origin(t:String):String{val s=norm(t).lowercase();return when{Regex("\\busa\\b|сша|американ").containsMatchIn(s)->"USA";Regex("\\bchina\\b|китай").containsMatchIn(s)->"CHINA";Regex("\\bgermany\\b|герман").containsMatchIn(s)->"GERMANY";else->""}}
 fun paintedParts(t:String):Int?=Regex("(?i)(?:крашен(?:ых|ые)?|окрашен(?:ых|ые)?|painted)[^\\d]{0,20}(\\d+)").find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
 fun name(t:String)=norm(t).lines().map{it.trim()}.firstOrNull{it.length in 3..80&&it.matches(Regex(".*[А-ЯA-Za-z].*"))&&!it.contains("₽")&&!it.contains("л.с")&&!it.contains("км",true)&&!it.contains("баланс",true)&&!it.contains("гараж",true)&&!it.contains("контракт",true)}?:""
 fun event(t:String):String?{val s=norm(t).lowercase();return when{purchaseAmount(t)!=null||Regex("\\bкупил\\b|покупка").containsMatchIn(s)->"ПОКУПКА";saleAmount(t)!=null||Regex("\\bпродал\\b|продажа").containsMatchIn(s)->"ПРОДАЖА";s.contains("аукцион")||s.contains("ставк")->"АУКЦИОН";expenseAmount(t)!=null||s.contains("комис")||s.contains("осмотр")||s.contains("автотек")||s.contains("расход")->"РАСХОД";else->null}}
 fun contract(t:String):String?=if(norm(t).contains("Кинопродюсер",true))"Кинопродюсер • USA • ≥300 л.с. • ≤2 500 000 ₽ • ≤99 крашеных • +200 000 ₽" else null
 fun decision(v:VehicleSnapshot)=when{v.price!=null&&v.price>2500000L->"НЕ ПОКУПАЙ";v.hp!=null&&v.hp<300->"НЕ ПОКУПАЙ";v.paintedParts!=null&&v.paintedParts>99->"НЕ ПОКУПАЙ";v.price!=null&&v.hp!=null&&v.price<=2500000L&&v.hp>=300&&v.origin=="USA"&&(v.paintedParts==null||v.paintedParts<=99)->"ПОКУПАЙ";v.price!=null||v.hp!=null||v.origin.isNotEmpty()->"ПРОВЕРЯЙ";else->"СМОТРЮ…"}
}


data class PlayerState(
    val level:Int?=null,val xp:Int?=null,val xpMax:Int?=null,val respect:Int?=null,
    val balance:Long?=null,val garageUsed:Int?=null,val garageCapacity:Int?=null,
    val creditStatus:String?=null,val vip:String?=null
)
data class GameSectionState(val section:String,val seen:Int=0,val lastSeenAt:Long=System.currentTimeMillis())
data class GameState(
    val player:PlayerState=PlayerState(),val vehicle:VehicleSnapshot=VehicleSnapshot(),
    val activeSection:String="",val activeOperation:String?=null,
    val sections:List<GameSectionState> = emptyList(),val lastEvent:String?=null,
    val updatedAt:Long=System.currentTimeMillis()
)
data class GameOpportunity(
    val action:String,val section:String,val title:String,val reason:String,
    val expectedValue:Long?=null,val confidence:Int=0
)

object WholeGameParser {
 fun level(t:String):Int?=Regex("(?i)(?:уровень|level)\\s*[:№-]?\\s*(\\d+)").find(t)?.groupValues?.get(1)?.toIntOrNull()
 fun xp(t:String):Pair<Int,Int?>? { val m=Regex("(?i)(?:xp|опыт)\\s*[:]?\\s*(\\d+)\\s*/\\s*(\\d+)").find(t)?:return null;return Pair(m.groupValues[1].toIntOrNull()?:return null,m.groupValues[2].toIntOrNull()) }
 fun respect(t:String):Int?=Regex("(?i)(?:уважение|respect)\\s*[:]?\\s*(\\d+)").find(t)?.groupValues?.get(1)?.toIntOrNull()
 fun section(t:String):String { val s=t.lowercase();return when {
  s.contains("рынок авто")->"РЫНОК АВТО";s.contains("автосалон")->"АВТОСАЛОН";s.contains("аукцион номеров")->"АУКЦИОН НОМЕРОВ"
  s.contains("импорт с таможни")||s.contains("таможн")->"ТАМОЖНЯ";s.contains("бизнес")->"БИЗНЕСЫ";s.contains("работа")->"РАБОТА"
  s.contains("клан")->"КЛАНЫ";s.contains("пари")||s.contains("ставк")->"ПАРИ";s.contains("уличн")&&s.contains("гон")->"УЛИЧНЫЕ ГОНКИ"
  s.contains("гаражная находка")->"ГАРАЖНАЯ НАХОДКА";s.contains("сходка")||s.contains("тц")->"СХОДКА У ТЦ"
  s.contains("реферал")->"РЕФЕРАЛЫ";s.contains("частн")&&s.contains("авторын")->"ЧАСТНЫЕ АВТОРЫНКИ"
  s.contains("финансов")->"ФИНАНСОВЫЙ СЕКТОР";s.contains("гараж")->"ГАРАЖ";s.contains("профиль")->"ПРОФИЛЬ";else->"ДРУГОЕ" } }
}
object WholeGameState {
 private const val PREF="whole_game_state"
 private fun p(c:Context)=c.getSharedPreferences(PREF,Context.MODE_PRIVATE)
 fun update(c:Context,text:String,v:VehicleSnapshot,balance:Long,garage:Int,event:String?){
  val old=read(c);val xp=WholeGameParser.xp(text);val lvl=WholeGameParser.level(text);val respect=WholeGameParser.respect(text);val section=WholeGameParser.section(text)
  val player=PlayerState(lvl?:old.player.level,xp?.first?:old.player.xp,xp?.second?:old.player.xpMax,respect?:old.player.respect,balance,garage,old.player.creditStatus,old.player.vip)
  val o=JSONObject().put("level",player.level).put("xp",player.xp).put("xpMax",player.xpMax).put("respect",player.respect).put("balance",balance).put("garageUsed",garage)
    .put("section",section).put("lastEvent",event).put("updatedAt",System.currentTimeMillis())
  p(c).edit().putString("state",o.toString()).apply()
  if(section!="ДРУГОЕ"&&section!=old.activeSection)CopilotState.addEvent(c,"ЗОНА • $section")
 }
 fun read(c:Context):GameState { val o=JSONObject(p(c).getString("state","{}")?: "{}");val old=PlayerState(
  if(o.has("level"))o.optInt("level")else null,if(o.has("xp"))o.optInt("xp")else null,if(o.has("xpMax"))o.optInt("xpMax")else null,
  if(o.has("respect"))o.optInt("respect")else null,if(o.has("balance"))o.optLong("balance")else null,
  if(o.has("garageUsed"))o.optInt("garageUsed")else null,null,null,null)
  return GameState(old,CopilotState.snapshot(c),o.optString("section"),null,emptyList(),o.optString("lastEvent").ifBlank{null},o.optLong("updatedAt")) }
}
object WholeGameOpportunityEngine {
 private val knownSections=setOf("АВТОСАЛОН","АУКЦИОН НОМЕРОВ","ТАМОЖНЯ","БИЗНЕСЫ","РАБОТА","КЛАНЫ","ПАРИ","УЛИЧНЫЕ ГОНКИ","ГАРАЖНАЯ НАХОДКА","СХОДКА У ТЦ","РЕФЕРАЛЫ","ЧАСТНЫЕ АВТОРЫНКИ","ФИНАНСОВЫЙ СЕКТОР")
 fun analyze(c:Context,text:String,v:VehicleSnapshot,balance:Long,garage:Int):GameOpportunity {
  val section=WholeGameParser.section(text)
  if(section=="ПРОФИЛЬ")return GameOpportunity("ИЗУЧАЙ",section,"Профиль","Собираю уровень, XP, уважение и ограничения",null,90)
  if(section=="РЫНОК АВТО"&&v.price!=null)return GameOpportunity(GameParser.decision(v),section,"Сделка","Проверяю цену входа, состояние и выход",null,75)
  if(section=="ГАРАЖ")return GameOpportunity("ПРОВЕРЯЙ АКТИВЫ",section,"Гараж","Учитываю занятый капитал и свободные слоты",null,80)
  if(section in knownSections)return GameOpportunity("СОБИРАЙ ДАННЫЕ",section,"Изучаем $section","Фиксирую операции, стоимость, награды и результат; пока данных недостаточно",null,35)
  return GameOpportunity("СОБИРАЙ ДАННЫЕ",section,"Новая игровая зона","Фиксирую экран и доступные операции",null,25)
 }
}
