package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class VehicleSnapshot(val name:String="",val price:Long?=null,val hp:Int?=null,val mileage:Long?=null,val owners:Int?=null,val plate:String="",val origin:String="",val paintedParts:Int?=null,val raw:String="",val updatedAt:Long=System.currentTimeMillis())
data class LedgerEvent(val type:String,val amount:Long?=null,val note:String="",val time:Long=System.currentTimeMillis())

object CopilotState {
    private const val PREF="copilot_state"; private const val BALANCE=8741902L
    fun prefs(c:Context)=c.getSharedPreferences(PREF,Context.MODE_PRIVATE)
    fun balance(c:Context)=prefs(c).getLong("balance",BALANCE)
    fun setBalance(c:Context,v:Long)=prefs(c).edit().putLong("balance",v).apply()
    fun garage(c:Context)=prefs(c).getInt("garage",0)
    fun setGarage(c:Context,v:Int)=prefs(c).edit().putInt("garage",v.coerceIn(0,3)).apply()
    fun decision(c:Context)=prefs(c).getString("decision","СМОТРЮ…")?:"СМОТРЮ…"
    fun setDecision(c:Context,v:String)=prefs(c).edit().putString("decision",v).apply()
    fun snapshot(c:Context):VehicleSnapshot {
        val s=prefs(c).getString("vehicle","")?:""; if(s.isEmpty())return VehicleSnapshot()
        return try{val o=JSONObject(s);VehicleSnapshot(o.optString("name"),o.optLong("price").takeIf{!o.isNull("price")&&o.has("price")},o.optInt("hp").takeIf{it>0},o.optLong("mileage").takeIf{it>0},o.optInt("owners").takeIf{it>0},o.optString("plate"),o.optString("origin"),o.optInt("paintedParts").takeIf{it>0},o.optString("raw"),o.optLong("updatedAt"))}catch(_:Exception){VehicleSnapshot()}
    }
    fun setSnapshot(c:Context,v:VehicleSnapshot){
        val o=JSONObject().put("name",v.name).put("plate",v.plate).put("origin",v.origin).put("raw",v.raw.take(6000)).put("updatedAt",v.updatedAt)
        if(v.price!=null)o.put("price",v.price);if(v.hp!=null)o.put("hp",v.hp);if(v.mileage!=null)o.put("mileage",v.mileage);if(v.owners!=null)o.put("owners",v.owners);if(v.paintedParts!=null)o.put("paintedParts",v.paintedParts)
        prefs(c).edit().putString("vehicle",o.toString()).apply()
    }
    fun addEvent(c:Context,text:String){val p=prefs(c);val a=JSONArray(p.getString("events","[]"));val key=text.hashCode().toString();for(i in 0 until a.length())if(a.optJSONObject(i)?.optString("key")==key)return;a.put(JSONObject().put("key",key).put("text",text.take(700)).put("time",System.currentTimeMillis()));while(a.length()>150)a.remove(0);p.edit().putString("events",a.toString()).apply()}
    fun events(c:Context):List<String>{val a=JSONArray(prefs(c).getString("events","[]"));return(0 until a.length()).mapNotNull{a.optJSONObject(it)?.optString("text")}.reversed()}
    fun addLedger(c:Context,type:String,amount:Long?,note:String){if(amount==null)return;val p=prefs(c);val a=JSONArray(p.getString("ledger","[]"));val key=(type+"|"+amount+"|"+note+"|"+(System.currentTimeMillis()/15000)).hashCode().toString();a.put(JSONObject().put("key",key).put("type",type).put("amount",amount).put("note",note).put("time",System.currentTimeMillis()));while(a.length()>150)a.remove(0);p.edit().putString("ledger",a.toString()).apply()}
    fun ledger(c:Context):List<LedgerEvent>{val a=JSONArray(prefs(c).getString("ledger","[]"));return(0 until a.length()).map{val o=a.getJSONObject(it);LedgerEvent(o.optString("type"),o.optLong("amount"),o.optString("note"),o.optLong("time"))}.reversed()}
}
object GameParser {
    private fun norm(s:String)=s.replace('\u00A0',' ').replace(Regex("[\\t\\r]+")," ")
    private fun number(s:String)=s.replace(" ","").replace("\u00A0","").replace("₽","").replace(",","").toLongOrNull()
    fun balance(t:String):Long?{val re=Regex("(?i)(?:баланс|счет|счёт|наличн|деньг|капитал|кошел).{0,35}(\\d{1,3}(?:[ .]\\d{3}){1,2}|\\d{6,9})");return norm(t).lines().asSequence().mapNotNull{re.find(it)?.groupValues?.getOrNull(1)?.let(::number)}.firstOrNull()}
    fun garage(t:String):Int?=Regex("(?i)(?:гараж|garage)\\s*[:\\-]?\\s*(\\d+)\\s*/\\s*(\\d+)").find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
    fun transactionAmount(t:String):Long?=Regex("(?i)(?:купил|покупка|продал|продажа|сумма|итого|получил|выручил|списан|оплатил).{0,45}(\\d{1,3}(?:[ .]\\d{3}){1,2}|\\d{6,9})\\s*₽?").find(norm(t))?.groupValues?.get(1)?.let(::number)
    fun price(t:String):Long?=Regex("(?<!\\d)(\\d{1,3}(?: \\d{3}){1,2}|\\d{6,9})(?:\\s*₽)?").find(norm(t))?.groupValues?.get(1)?.let(::number)
    fun hp(t:String)=Regex("(?<!\\d)(\\d{2,4})\\s*(?:л\\.\\s*с\\.?|лс|hp)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
    fun mileage(t:String)=Regex("(?<!\\d)(\\d{1,3}(?: \\d{3})+|\\d{5,7})\\s*(?:км|km)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.let(::number)
    fun owners(t:String)=Regex("(\\d+)\\s*(?:владельц|owner)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
    fun plate(t:String)=Regex("\\b[А-ЯA-Z]\\d{3}[А-ЯA-Z]{2}\\s*\\d{2,3}\\b",RegexOption.IGNORE_CASE).find(norm(t))?.value?:""
    fun origin(t:String):String{val s=norm(t).lowercase();return when{Regex("\\busa\\b|сша|американ").containsMatchIn(s)->"USA";Regex("\\bchina\\b|китай").containsMatchIn(s)->"CHINA";Regex("\\bgermany\\b|герман").containsMatchIn(s)->"GERMANY";else->""}}
    fun paintedParts(t:String):Int?=Regex("(?i)(?:крашен(?:ых|ые)?|окрашен(?:ых|ые)?|painted).{0,20}(\\d+)").find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
    fun name(t:String)=norm(t).lines().map{it.trim()}.firstOrNull{it.length in 3..80&&it.matches(Regex(".*[А-ЯA-Za-z].*"))&&!it.contains("₽")&&!it.contains("л.с")&&!it.contains("км",true)&&!it.contains("баланс",true)&&!it.contains("гараж",true)}?:""
    fun event(t:String):String?{val s=norm(t).lowercase();return when{Regex("\\bкупил\\b|покупка|купить").containsMatchIn(s)->"ПОКУПКА";Regex("\\bпродал\\b|продажа|продать").containsMatchIn(s)->"ПРОДАЖА";s.contains("аукцион")||s.contains("ставк")->"АУКЦИОН";s.contains("комис")||s.contains("осмотр")||s.contains("автотек")||s.contains("расход")->"РАСХОД";else->null}}
    fun contract(t:String):String?=if(norm(t).contains("Кинопродюсер",true))"Кинопродюсер • USA • ≥300 л.с. • ≤2 500 000 ₽ • бонус +200 000 ₽" else null
    fun decision(v:VehicleSnapshot):String=when{v.price!=null&&v.price>2500000L->"НЕ ПОКУПАЙ";v.hp!=null&&v.hp<300->"НЕ ПОКУПАЙ";v.paintedParts!=null&&v.paintedParts>99->"НЕ ПОКУПАЙ";v.price!=null&&v.hp!=null&&v.price<=2500000L&&v.hp>=300&&v.origin=="USA"&&(v.paintedParts==null||v.paintedParts<=99)->"ПОКУПАЙ";v.price!=null||v.hp!=null->"ПРОВЕРЯЙ";else->"СМОТРЮ…"}
}
