package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

object ModelFeatureLearning {
    private const val PREF="copilot_model_learning"
    private const val DATA="data"
    private fun p(c:Context)=c.getSharedPreferences(PREF,Context.MODE_PRIVATE)
    private fun arr(c:Context)=try{JSONArray(p(c).getString(DATA,"[]"))}catch(_:Exception){JSONArray()}
    private fun norm(s:String)=s.lowercase().replace('ё','е').trim()
    private fun bucketMileage(v:Long?)=when{v==null->"unknown";v<50000->"<50k";v<100000->"50-100k";v<150000->"100-150k";v<200000->"150-200k";else->"200k+"}
    private fun bucketOwners(v:Int?)=when{v==null->"unknown";v<=1->"1";v==2->"2";v==3->"3";else->"4+"}
    private fun key(v:VehicleSnapshot)=norm(v.name)+"|mileage="+bucketMileage(v.mileage)+"|owners="+bucketOwners(v.owners)+"|painted="+(v.paintedParts?.toString()?:"unknown")
    fun learn(c:Context,v:VehicleSnapshot,profit:Long,fees:Long=0L){
        if(v.name.isBlank())return
        val a=arr(c);val k=key(v);var o:JSONObject?=null
        for(i in 0 until a.length()){val x=a.optJSONObject(i)?:continue;if(x.optString("key")==k){o=x;break}}
        if(o==null)o=JSONObject().put("key",k).put("model",v.name).put("mileage_bucket",bucketMileage(v.mileage)).put("owners_bucket",bucketOwners(v.owners)).put("painted_parts",v.paintedParts)
            .put("deals",0).put("profitable_deals",0).put("loss_deals",0).put("total_profit",0)
        val deals=o.optInt("deals")+1;o.put("deals",deals)
        if(profit>0)o.put("profitable_deals",o.optInt("profitable_deals")+1) else if(profit<0)o.put("loss_deals",o.optInt("loss_deals")+1)
        o.put("total_profit",o.optLong("total_profit")+profit).put("last_profit",profit).put("last_seen",System.currentTimeMillis())
        val avg=o.optDouble("avg_profit",0.0);o.put("avg_profit",o.optLong("total_profit").toDouble()/deals)
        val profitRate=o.optInt("profitable_deals").toDouble()/deals*100.0;o.put("profit_rate_percent",profitRate)
        var replaced=false;for(i in 0 until a.length()){if(a.optJSONObject(i)?.optString("key")==k){a.put(i,o);replaced=true;break}}
        if(!replaced)a.put(o);while(a.length()>120)a.remove(0);p(c).edit().putString(DATA,a.toString()).apply()
    }
    fun snapshot(c:Context):JSONObject{
        val a=arr(c);val out=JSONArray()
        val list=(0 until a.length()).mapNotNull{a.optJSONObject(it)}.sortedByDescending{it.optInt("deals")}
        list.take(40).forEach{out.put(it)}
        return JSONObject().put("groups",out).put("group_count",a.length()).put("source","observed_completed_deals")
    }
    fun match(c:Context,v:VehicleSnapshot):JSONObject?{
        val k=key(v);val a=arr(c);for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optString("key")==k)return o}
        val model=norm(v.name);return (0 until a.length()).mapNotNull{a.optJSONObject(it)}.filter{norm(it.optString("model"))==model}.maxByOrNull{it.optInt("deals")}
    }
    fun recommendationEvidence(c:Context,v:VehicleSnapshot):List<String>{
        val o=match(c,v)?:return emptyList()
        return listOf("model_feature_history="+o.optInt("deals")+" deals","feature_profit_rate="+String.format("%.1f",o.optDouble("profit_rate_percent"))+"%","feature_avg_profit="+o.optLong("avg_profit")+" ₽")
    }
}
