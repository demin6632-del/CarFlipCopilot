package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object StrategySequenceLearning {
    private const val PREF="copilot_strategy_sequences"
    private const val DATA="sequences"
    private const val MIN=2
    private fun p(c:Context)=c.getSharedPreferences(PREF,Context.MODE_PRIVATE)
    private fun norm(s:String)=s.trim().uppercase().take(60)
    private fun arr(c:Context)=try{JSONArray(p(c).getString(DATA,"[]"))}catch(_:Exception){JSONArray()}
    fun learnDeal(c:Context,v:VehicleSnapshot,dealId:String,plate:String="",profitable:Boolean=false){
        val history=try{JSONArray(c.getSharedPreferences("copilot_learning",Context.MODE_PRIVATE).getString("action_history","[]"))}catch(_:Exception){JSONArray()}
        val actions=mutableListOf<Pair<Long,String>>()
        for(i in 0 until history.length()){
            val o=history.optJSONObject(i)?:continue
            if(dealId.isNotEmpty()&&o.optString("deal_id")!=dealId)continue
            if(plate.isNotEmpty()&&o.optString("plate").isNotEmpty()&&o.optString("plate")!=plate)continue
            val a=norm(o.optString("action"));if(a.isBlank())continue
            actions+=o.optLong("time",0L) to a
        }
        val ordered=actions.sortedBy{it.first}.map{it.second}.distinctConsecutive()
        if(ordered.size<2)return
        val a=arr(c)
        for(size in 2..minOf(3,ordered.size)){
            for(start in 0..ordered.size-size){
                val seq=ordered.subList(start,start+size)
                val key=seq.joinToString(" -> ")
                var o:JSONObject?=null
                for(i in 0 until a.length()){val x=a.optJSONObject(i);if(x?.optString("key")==key){o=x;break}}
                if(o==null)o=JSONObject().put("key",key).put("steps",JSONArray(seq)).put("confirmations",0).put("successes",0).put("last_seen",0)
                o.put("confirmations",o.optInt("confirmations")+1).put("deal_profitable",profitable)
                if(profitable)o.put("successes",o.optInt("successes")+1)
                o.put("last_seen",System.currentTimeMillis()).put("status",if(o.optInt("confirmations")>=MIN)"CONFIRMED":"OBSERVED_ONCE")
                var replaced=false
                for(i in 0 until a.length())if(a.optJSONObject(i)?.optString("key")==key){a.put(i,o);replaced=true;break}
                if(!replaced)a.put(o)
            }
        }
        while(a.length()>100)a.remove(0)
        p(c).edit().putString(DATA,a.toString()).apply()
    }
    private fun <T> List<T>.distinctConsecutive():List<T>{val out=mutableListOf<T>();for(x in this)if(out.isEmpty()||out.last()!=x)out+=x;return out}
    fun snapshot(c:Context):JSONObject{
        val a=arr(c);val out=JSONArray()
        for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optInt("confirmations")>=MIN)out.put(o)}
        return JSONObject().put("confirmed_sequences",out).put("count",out.length()).put("source","observed_completed_deals")
    }
    fun evidence(c:Context):List<String>{
        val a=arr(c);val out=mutableListOf<String>()
        for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optInt("confirmations")>=MIN)out+="sequence="+o.optString("key")+"; confirmations="+o.optInt("confirmations")}
        return out.take(6)
    }
}
