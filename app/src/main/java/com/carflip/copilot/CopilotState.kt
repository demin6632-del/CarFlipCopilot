package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class VehicleSnapshot(val name:String="",val price:Long?=null,val hp:Int?=null,val mileage:Long?=null,val owners:Int?=null,val plate:String="",val origin:String="",val paintedParts:Int?=null,val raw:String="",val updatedAt:Long=System.currentTimeMillis())
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
  return try{val o=JSONObject(s);VehicleSnapshot(o.optString("name"),if(o.has("price"))o.optLong("price")else null,if(o.has("hp"))o.optInt("hp")else null,if(o.has("mileage"))o.optLong("mileage")else null,if(o.has("owners"))o.optInt("owners")else null,o.optString("plate"),o.optString("origin"),if(o.has("paintedParts"))o.optInt("paintedParts")else null,o.optString("raw"),o.optLong("updatedAt"))}catch(_:Exception){VehicleSnapshot()}
 }
 fun setSnapshot(c:Context,v:VehicleSnapshot){val o=JSONObject().put("name",v.name).put("plate",v.plate).put("origin",v.origin).put("raw",v.raw.take(8000)).put("updatedAt",v.updatedAt);v.price?.let{o.put("price",it)};v.hp?.let{o.put("hp",it)};v.mileage?.let{o.put("mileage",it)};v.owners?.let{o.put("owners",it)};v.paintedParts?.let{o.put("paintedParts",it)};p(c).edit().putString("vehicle",o.toString()).apply()}
 private fun append(c:Context,keyName:String,obj:JSONObject,max:Int=200){val pref=p(c);val a=JSONArray(pref.getString(keyName,"[]"));val key=obj.optString("key");if(key.isNotEmpty())for(i in 0 until a.length())if(a.optJSONObject(i)?.optString("key")==key)return;a.put(obj);while(a.length()>max)a.remove(0);pref.edit().putString(keyName,a.toString()).apply()}
 fun addEvent(c:Context,text:String){append(c,"events",JSONObject().put("key",text.hashCode().toString()+"|"+System.currentTimeMillis()/5000).put("text",text.take(900)).put("time",System.currentTimeMillis()))}
fun saveAttachmentAnalysis(c:Context,name:String,json:String){
 val compact=json.replace("\\n"," ").take(5000)
 p(c).edit().putString("last_attachment_analysis",name+"|"+compact).apply()
 addEvent(c,"ВЛОЖЕНИЕ • "+name+" • AI-анализ получен")
}
fun lastAttachmentAnalysis(c:Context)=p(c).getString("last_attachment_analysis","")?:""
 fun events(c:Context):List<String>{val a=JSONArray(p(c).getString("events","[]"));return(0 until a.length()).mapNotNull{a.optJSONObject(it)?.optString("text")}.reversed()}
 fun addLedger(c:Context,type:String,amount:Long?,note:String){if(amount==null)return;append(c,"ledger",JSONObject().put("key",(type+"|"+amount+"|"+note).hashCode().toString()).put("type",type).put("amount",amount).put("note",note.take(500)).put("time",System.currentTimeMillis()))}
 fun ledger(c:Context):List<LedgerEvent>{val a=JSONArray(p(c).getString("ledger","[]"));return(0 until a.length()).map{val o=a.getJSONObject(it);LedgerEvent(o.optString("type"),o.optLong("amount"),o.optString("note"),o.optLong("time"))}.reversed()}
 fun recordPurchase(c:Context,v:VehicleSnapshot,amount:Long){val id=(v.plate.ifEmpty{v.name}).ifEmpty{"deal"}+"|"+System.currentTimeMillis();val o=JSONObject().put("id",id).put("name",v.name).put("plate",v.plate).put("buy",amount).put("fees",0L).put("opened",System.currentTimeMillis());append(c,"deals",o);addLedger(c,"ПОКУПКА",-amount,v.name.ifEmpty{"авто"})}
 fun recordSale(c:Context,v:VehicleSnapshot,amount:Long){val a=JSONArray(p(c).getString("deals","[]"));var idx=-1;for(i in a.length()-1 downTo 0){val o=a.optJSONObject(i)?:continue;if(!o.has("sell")&&((v.plate.isNotEmpty()&&o.optString("plate")==v.plate)||(v.plate.isEmpty()&&o.optString("name")==v.name))){idx=i;break}};var learnedProfit:Long?=null;if(idx>=0){val existing=a.getJSONObject(idx);val buy=if(existing.has("buy"))existing.optLong("buy") else 0L;val fees=existing.optLong("fees");learnedProfit=amount-buy-fees;a.put(idx,existing.put("sell",amount).put("closed",System.currentTimeMillis()))}else{a.put(JSONObject().put("id",(v.plate.ifEmpty{v.name})+"|"+System.currentTimeMillis()).put("name",v.name).put("plate",v.plate).put("sell",amount).put("fees",0L).put("opened",System.currentTimeMillis()).put("closed",System.currentTimeMillis()))};while(a.length()>200)a.remove(0);p(c).edit().putString("deals",a.toString()).apply();learnedProfit?.let{LearningMemory.learn(c,v,it);addEvent(c,"ОБУЧЕНИЕ • результат "+it+" ₽ • модель "+v.name)};addLedger(c,"ПРОДАЖА",amount,v.name.ifEmpty{"авто"})}
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
 fun expenseAmount(t:String)=contextAmount(t,"оплатил|списан|расход|осмотр|автотека|комисси|сняти[ея]")
 fun price(t:String):Long?{val s=norm(t);val c=Regex("(?i)(?:цена|стоимость|предлагает|торг|продаёт|продает|купить)[^\\d]{0,30}(\\d{1,3}(?:[ .]\\d{3}){1,2}|\\d{6,9})").find(s);if(c!=null)return c.groupValues[1].let(::num);return Regex("(?<!\\d)(\\d{1,3}(?: \\d{3}){1,2})(?:\\s*₽)").find(s)?.groupValues?.get(1)?.let(::num)}
 fun hp(t:String)=Regex("(?<!\\d)(\\d{2,4})\\s*(?:л\\.\\s*с\\.?|лс|hp)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
 fun mileage(t:String)=Regex("(?<!\\d)(\\d{1,3}(?: \\d{3})+|\\d{5,7})\\s*(?:км|km)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.let(::num)
 fun owners(t:String)=Regex("(\\d+)\\s*(?:владельц|owner)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
 fun plate(t:String)=Regex("\\b[А-ЯA-Z]\\d{3}[А-ЯA-Z]{2}\\s*\\d{2,3}\\b",RegexOption.IGNORE_CASE).find(norm(t))?.value?:""
 fun origin(t:String):String{val s=norm(t).lowercase();return when{Regex("\\busa\\b|сша|американ").containsMatchIn(s)->"USA";Regex("\\bchina\\b|китай").containsMatchIn(s)->"CHINA";Regex("\\bgermany\\b|герман").containsMatchIn(s)->"GERMANY";else->""}}
 fun paintedParts(t:String):Int?=Regex("(?i)(?:крашен(?:ых|ые)?|окрашен(?:ых|ые)?|painted)[^\\d]{0,20}(\\d+)").find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
 fun name(t:String)=norm(t).lines().map{it.trim()}.firstOrNull{it.length in 3..80&&it.matches(Regex(".*[А-ЯA-Za-z].*"))&&!it.contains("₽")&&!it.contains("л.с")&&!it.contains("км",true)&&!it.contains("баланс",true)&&!it.contains("гараж",true)&&!it.contains("контракт",true)}?:""
 fun event(t:String):String?{val s=norm(t).lowercase();return when{purchaseAmount(t)!=null||Regex("\\bкупил\\b|покупка").containsMatchIn(s)->"ПОКУПКА";saleAmount(t)!=null||Regex("\\bпродал\\b|продажа").containsMatchIn(s)->"ПРОДАЖА";s.contains("аукцион")||s.contains("ставк")->"АУКЦИОН";expenseAmount(t)!=null||s.contains("комис")||s.contains("осмотр")||s.contains("автотек")||s.contains("расход")->"РАСХОД";else->null}}
 fun contract(t:String):String?=if(norm(t).contains("Кинопродюсер",true))"Кинопродюсер • USA • ≥300 л.с. • ≤2 500 000 ₽ • ≤99 крашеных • +200 000 ₽" else null
 fun decision(v:VehicleSnapshot)=when{v.price!=null&&v.price>2500000L->"НЕ ПОКУПАЙ";v.hp!=null&&v.hp<300->"НЕ ПОКУПАЙ";v.paintedParts!=null&&v.paintedParts>99->"НЕ ПОКУПАЙ";v.price!=null&&v.hp!=null&&v.price<=2500000L&&v.hp>=300&&v.origin=="USA"&&(v.paintedParts==null||v.paintedParts<=99)->"ПОКУПАЙ";v.price!=null||v.hp!=null||v.origin.isNotEmpty()->"ПРОВЕРЯЙ";else->"СМОТРЮ…"}
}
