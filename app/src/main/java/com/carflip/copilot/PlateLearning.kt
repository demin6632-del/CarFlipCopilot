package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Learns plate-auction economics separately from vehicle economics. */
object PlateLearning {
 private const val KEY="plate_learning"
 private fun prefs(c:Context)=c.getSharedPreferences("copilot_state",Context.MODE_PRIVATE)
 private fun records(c:Context):JSONArray=try{JSONArray(prefs(c).getString(KEY,"[]")?:"[]")}catch(_:Exception){JSONArray()}
 fun recordSale(c:Context,plate:String){
  if(plate.isBlank())return
  val a=records(c);val auction=CopilotState.plateAuction(c,plate);val sale=if(auction.has("final_price"))auction.optLong("final_price")else return
  val cost=CopilotState.plateCost(c,plate)?:return;val fees=auction.optLong("fees",0);val net=sale-cost-fees
  val o=JSONObject().put("plate",plate).put("sale",sale).put("cost",cost).put("fees",fees).put("net",net).put("roi",if(cost>0)net.toDouble()/cost*100.0 else 0.0).put("time",System.currentTimeMillis())
  a.put(o);while(a.length()>200)a.remove(0);prefs(c).edit().putString(KEY,a.toString()).apply()
  CopilotState.addEvent(c,"ОБУЧЕНИЕ НОМЕРА • "+plate+" • чистый результат "+net+" ₽ • ROI "+String.format("%.1f",o.optDouble("roi"))+"%")
 }
 fun summary(c:Context,plate:String):String{
  val a=records(c);var n=0;var net=0L;var roi=0.0
  for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optString("plate")!=plate)continue;n++;net+=o.optLong("net");roi+=o.optDouble("roi")}
  return if(n==0)"нет истории" else "сделок: $n • суммарный результат: $net ₽ • средний ROI: "+String.format("%.1f",roi/n)+"%"
 }
 fun historyCount(c:Context,plate:String):Int{val a=records(c);var n=0;for(i in 0 until a.length())if(a.optJSONObject(i)?.optString("plate")==plate)n++;return n}
 fun averageRoi(c:Context,plate:String):Double?{val a=records(c);var n=0;var sum=0.0;for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optString("plate")!=plate)continue;n++;sum+=o.optDouble("roi",0.0)};return if(n==0)null else sum/n}
 fun averageNet(c:Context,plate:String):Long?{val a=records(c);var n=0;var sum=0L;for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optString("plate")!=plate)continue;n++;sum+=o.optLong("net",0)};return if(n==0)null else sum/n}
}