package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

data class RecommendationQuality(
    val action:String,
    val samples:Int,
    val positive:Int,
    val negative:Int,
    val accuracy:Int,
    val trust:Int
)

object RecommendationLearning {
 private const val PREF="copilot_recommendation_learning"
 private const val HISTORY="history"
 private const val MAX_HISTORY=160

 private fun p(c:Context)=c.getSharedPreferences(PREF,Context.MODE_PRIVATE)
 private fun arr(c:Context)=JSONArray(p(c).getString(HISTORY,"[]"))
 private fun norm(s:String)=s.lowercase().replace('ё','е').replace(Regex("\s+")," ").trim()
 private fun save(c:Context,a:JSONArray){while(a.length()>MAX_HISTORY)a.remove(0);p(c).edit().putString(HISTORY,a.toString()).apply()}

 fun record(c:Context,source:String,action:String,title:String,confidence:Int,v:VehicleSnapshot){
  if(action.isBlank()||action=="НАБЛЮДАЙ")return
  val a=arr(c)
  val now=System.currentTimeMillis()
  val n=norm(action)
  for(i in a.length()-1 downTo 0){
   val o=a.optJSONObject(i)?:continue
   if(o.has("outcome")&&o.optString("action_norm")==n&&now-o.optLong("time",0)<45000L)return
  }
  val open=CopilotState.deals(c).firstOrNull{it.sell==null&&(v.plate.isBlank()||it.plate.isBlank()||it.plate==v.plate)}
  a.put(JSONObject()
   .put("source",source)
   .put("action",action)
   .put("action_norm",n)
   .put("title",title.take(300))
   .put("confidence",confidence.coerceIn(0,100))
   .put("name",v.name)
   .put("plate",v.plate)
   .put("deal_id",open?.id?:"")
   .put("time",now))
  save(c,a)
 }

 fun outcome(c:Context,v:VehicleSnapshot,profit:Long){
  val a=arr(c)
  val now=System.currentTimeMillis()
  var changed=false
  for(i in a.length()-1 downTo 0){
   val o=a.optJSONObject(i)?:continue
   if(o.has("outcome"))continue
   if(now-o.optLong("time",0)>30*60*1000L)continue
   val plate=o.optString("plate")
   val name=o.optString("name")
   if(plate.isNotBlank()&&v.plate.isNotBlank()&&plate!=v.plate)continue
   if(plate.isBlank()&&name.isNotBlank()&&v.name.isNotBlank()&&norm(name)!=norm(v.name))continue
   val success=profit>0L
   o.put("outcome",if(success)"POSITIVE" else if(profit<0)"NEGATIVE" else "NEUTRAL")
    .put("profit",profit)
    .put("outcome_time",now)
   a.put(i,o)
   changed=true
  }
  if(changed)save(c,a)
 }

 private fun qualityFrom(a:JSONArray,action:String):RecommendationQuality{
  val n=norm(action);var samples=0;var positive=0;var negative=0
  for(i in 0 until a.length()){
   val o=a.optJSONObject(i)?:continue
   if(o.optString("action_norm")!=n)continue
   when(o.optString("outcome")){
    "POSITIVE"->{samples++;positive++}
    "NEGATIVE"->{samples++;negative++}
   }
  }
  val accuracy=if(samples==0)0 else (positive.toDouble()/samples*100.0).roundToInt()
  val trust=when{
   samples>=10->(50+((accuracy-50)*0.8)).roundToInt().coerceIn(20,90)
   samples>=5->(50+((accuracy-50)*0.6)).roundToInt().coerceIn(25,80)
   samples>=3->(50+((accuracy-50)*0.4)).roundToInt().coerceIn(30,70)
   else->50
  }
  return RecommendationQuality(action,samples,positive,negative,accuracy,trust)
 }

 fun quality(c:Context,action:String):RecommendationQuality=qualityFrom(arr(c),action)

 fun snapshot(c:Context):JSONObject{
  val a=arr(c)
  val actions=linkedSetOf<String>()
  for(i in a.length()-1 downTo 0){val o=a.optJSONObject(i)?:continue;val action=o.optString("action");if(action.isNotBlank())actions.add(action)}
  val qs=JSONArray()
  actions.take(20).forEach{q->
   val x=qualityFrom(a,q)
   qs.put(JSONObject().put("action",x.action).put("samples",x.samples).put("positive",x.positive).put("negative",x.negative).put("accuracy",x.accuracy).put("trust",x.trust))
  }
  return JSONObject().put("observations",a.length()).put("qualities",qs)
 }

 fun evidence(c:Context,action:String):List<String>{
  val q=quality(c,action)
  if(q.samples==0)return emptyList()
  return listOf("recommendation_quality="+q.accuracy+"%","recommendation_samples="+q.samples,"recommendation_trust="+q.trust+"/100")
 }
}
