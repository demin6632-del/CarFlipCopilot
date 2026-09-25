package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class VehicleSnapshot(
    val name:String="", val price:Long?=null, val hp:Int?=null, val mileage:Long?=null,
    val owners:Int?=null, val plate:String="", val raw:String="", val updatedAt:Long=System.currentTimeMillis()
)

object CopilotState {
    private const val PREF="copilot_state"
    private const val BALANCE=8741902L
    fun prefs(c:Context)=c.getSharedPreferences(PREF,Context.MODE_PRIVATE)
    fun balance(c:Context)=prefs(c).getLong("balance",BALANCE)
    fun setBalance(c:Context,v:Long)=prefs(c).edit().putLong("balance",v).apply()
    fun snapshot(c:Context):VehicleSnapshot {
        val s=prefs(c).getString("vehicle","") ?: ""
        if(s.isEmpty()) return VehicleSnapshot()
        return try {
            val o=JSONObject(s)
            VehicleSnapshot(o.optString("name"),o.optLong("price").takeIf{!o.isNull("price")&&o.has("price")},
                o.optInt("hp").takeIf{it>0},o.optLong("mileage").takeIf{it>0},o.optInt("owners").takeIf{it>0},
                o.optString("plate"),o.optString("raw"),o.optLong("updatedAt"))
        } catch(_:Exception){VehicleSnapshot()}
    }
    fun setSnapshot(c:Context,v:VehicleSnapshot){
        val o=JSONObject().put("name",v.name)
        if(v.price!=null)o.put("price",v.price);if(v.hp!=null)o.put("hp",v.hp)
        if(v.mileage!=null)o.put("mileage",v.mileage);if(v.owners!=null)o.put("owners",v.owners)
        o.put("plate",v.plate).put("raw",v.raw.take(4000)).put("updatedAt",v.updatedAt)
        prefs(c).edit().putString("vehicle",o.toString()).apply()
    }
    fun addEvent(c:Context,text:String){
        val p=prefs(c);val a=JSONArray(p.getString("events","[]"));val key=text.hashCode().toString()
        for(i in 0 until a.length())if(a.optJSONObject(i)?.optString("key")==key)return
        a.put(JSONObject().put("key",key).put("text",text.take(500)).put("time",System.currentTimeMillis()))
        while(a.length()>50)a.remove(0);p.edit().putString("events",a.toString()).apply()
    }
    fun events(c:Context):List<String>{
        val a=JSONArray(prefs(c).getString("events","[]"))
        return (0 until a.length()).mapNotNull{a.optJSONObject(it)?.optString("text")}.reversed()
    }
}

object GameParser {
    private fun norm(s:String)=s.replace('\u00A0',' ').replace(Regex("[\\t\\r]+")," ")
    fun price(t:String):Long?=Regex("(?<!\\d)(\\d{1,3}(?: \\d{3}){1,2}|\\d{6,7})(?:\\s*₽)?").find(norm(t))?.groupValues?.get(1)?.replace(" ","")?.toLongOrNull()
    fun hp(t:String)=Regex("(?<!\\d)(\\d{2,4})\\s*(?:л\\.\\s*с\\.?|лс|hp)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
    fun mileage(t:String)=Regex("(?<!\\d)(\\d{1,3}(?: \\d{3})+|\\d{5,7})\\s*(?:км|km)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.replace(" ","")?.toLongOrNull()
    fun owners(t:String)=Regex("(\\d+)\\s*(?:владельц|owner)",RegexOption.IGNORE_CASE).find(norm(t))?.groupValues?.get(1)?.toIntOrNull()
    fun plate(t:String)=Regex("\\b[А-ЯA-Z]\\d{3}[А-ЯA-Z]{2}\\s*\\d{2,3}\\b",RegexOption.IGNORE_CASE).find(norm(t))?.value?:""
    fun name(t:String)=norm(t).lines().map{it.trim()}.firstOrNull{it.length in 3..80&&it.matches(Regex(".*[А-ЯA-Za-z].*"))&&!it.contains("₽")&&!it.contains("л.с")&&!it.contains("км",true)}?:""
    fun event(t:String):String?{
        val s=norm(t).lowercase()
        return when{
            s.contains("купил")||s.contains("покупка")||s.contains("купить")->"ПОКУПКА"
            s.contains("продал")||s.contains("продажа")||s.contains("продать")->"ПРОДАЖА"
            s.contains("аукцион")||s.contains("ставк")->"АУКЦИОН"
            s.contains("комис")||s.contains("осмотр")||s.contains("автотек")->"РАСХОД"
            else->null
        }
    }
    fun contract(t:String):String?=if(norm(t).contains("Кинопродюсер",true))"Кинопродюсер • USA • ≥300 л.с. • ≤2 500 000 ₽ • бонус +200 000 ₽" else null
}
