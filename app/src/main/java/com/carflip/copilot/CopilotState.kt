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
 private fun arr(c:Context,k:String)=JSONArray(p(c).getString(k,"[]"))
 private fun append(c:Context,k:String,o:JSONObject,max:Int=200){val a=arr(c,k);a.put(o);while(a.length()>max)a.remove(0);p(c).edit().putString(k,a.toString()).apply()}
 fun balance(c:Context)=p(c).getLong("balance",INITIAL_BALANCE)
 fun setBalance(c:Context,v:Long)=p(c).edit().putLong("balance",v).apply()
 fun garage(c:Context)=p(c).getInt("garage",0).coerceIn(0,3)
 fun setGarage(c:Context,v:Int)=p(c).edit().putInt("garage",v.coerceIn(0,3)).apply()
 fun decision(c:Context)=p(c).getString("decision","СМОТРЮ…")?:"СМОТРЮ…"
 fun setDecision(c:Context,v:String)=p(c).edit().putString("decision",v).apply()
 fun monitoring(c:Context)=p(c).getBoolean("monitoring",false)
 fun setMonitoring(c:Context,v:Boolean)=p(c).edit().putBoolean("monitoring",v).apply()
 fun snapshot(c:Context):VehicleSnapshot{val s=p(c).getString("vehicle","")?:"";if(s.isBlank())return VehicleSnapshot();return try{val o=JSONObject(s);VehicleSnapshot(o.optString("name"),if(o.has("price"))o.optLong("price")else null,if(o.has("hp"))o.optInt("hp")else null,if(o.has("mileage"))o.optLong("mileage")else null,if(o.has("owners"))o.optInt("owners")else null,o.optString("plate"),o.optString("origin"),if(o.has("paintedParts"))o.optInt("paintedParts")else null,o.optString("raw"),o.optLong("updatedAt"))}catch(_:Exception){VehicleSnapshot()}}
 fun setSnapshot(c:Context,v:VehicleSnapshot){val o=JSONObject().put("name",v.name).put("plate",v.plate).put("origin",v.origin).put("raw",v.raw.take(8000)).put("updatedAt",v.updatedAt);v.price?.let{o.put("price",it)};v.hp?.let{o.put("hp",it)};v.mileage?.let{o.put("mileage",it)};v.owners?.let{o.put("owners",it)};v.paintedParts?.let{o.put("paintedParts",it)};p(c).edit().putString("vehicle",o.toString()).apply()}
 fun addEvent(c:Context,text:String){append(c,"events",JSONObject().put("text",text.take(900)).put("time",System.currentTimeMillis()),500)}
 fun events(c:Context):List<String>{val a=arr(c,"events");return(0 until a.length()).mapNotNull{a.optJSONObject(it)?.optString("text")}.reversed()}
 fun saveAttachmentAnalysis(c:Context,name:String,json:String){p(c).edit().putString("last_attachment_analysis",name+"|"+json.take(5000)).apply();addEvent(c,"ВЛОЖЕНИЕ • "+name+" • AI-анализ получен")}
 fun lastAttachmentAnalysis(c:Context)=p(c).getString("last_attachment_analysis","")?:""
 fun saveForecast(c:Context,sale:Long?,profit:Long?,roi:Double?,confidence:Int?){val o=JSONObject();sale?.let{o.put("sale_price",it)};profit?.let{o.put("expected_profit",it)};roi?.let{o.put("roi_percent",it)};confidence?.let{o.put("confidence",it)};p(c).edit().putString("forecast",o.toString()).apply()}
 fun forecast(c:Context)=p(c).getString("forecast","{}")?:"{}"
 fun dealForecast(c:Context,v:VehicleSnapshot):JSONObject{val sale=LearningMemory.estimatedSale(c,v,v.price);val open=deals(c).firstOrNull{it.closed==null&&((v.plate.isNotEmpty()&&it.plate==v.plate)||(v.plate.isEmpty()&&it.name==v.name))};val buy=open?.buy?:v.price?:0L;val fees=open?.fees?:0L;val profit=sale?.minus(buy+fees);val roi=if(buy+fees>0&&profit!=null)profit.toDouble()/(buy+fees)*100 else null;return JSONObject().put("sale_price",sale).put("purchase",buy).put("fees",fees).put("expected_profit",profit).put("roi_percent",roi)}
 fun roi(cost:Long,delta:Long)=if(cost<=0)0.0 else (delta-cost).toDouble()/cost*100.0
 fun saveActionRoi(c:Context,action:String,cost:Long,delta:Long,reason:String="",dealId:String="",plate:String="",beforeSale:Long?=null){append(c,"action_roi",JSONObject().put("action",action).put("cost",cost).put("delta",delta).put("roi",roi(cost,delta)).put("reason",reason).put("deal_id",dealId).put("plate",plate).put("before_sale",beforeSale).put("time",System.currentTimeMillis()))}
 fun actionRoi(c:Context):List<String>{val a=arr(c,"action_roi");return(0 until a.length()).mapNotNull{val o=a.optJSONObject(it)?:return@mapNotNull null;"• "+o.optString("action")+" • "+o.optLong("cost")+" ₽ • ROI "+String.format("%.1f",o.optDouble("roi"))+"%"}.reversed()}
 fun addBuyerOffer(c:Context,plate:String,name:String,condition:String,amount:Long,buyer:String="",notes:String=""){append(c,"buyer_offers",JSONObject().put("plate",plate).put("name",name).put("condition",condition).put("amount",amount).put("buyer",buyer).put("notes",notes).put("time",System.currentTimeMillis()))}
 fun buyerOffers(c:Context,plate:String=""):List<String>{val a=arr(c,"buyer_offers");return(0 until a.length()).mapNotNull{val o=a.optJSONObject(it)?:return@mapNotNull null;if(plate.isNotEmpty()&&o.optString("plate")!=plate)return@mapNotNull null;"• "+o.optString("condition")+" → "+o.optLong("amount")+" ₽"+(if(o.optString("buyer").isNotBlank())" • "+o.optString("buyer") else "")}.reversed()}
 fun addLedger(c:Context,type:String,amount:Long?,note:String){if(amount!=null)append(c,"ledger",JSONObject().put("type",type).put("amount",amount).put("note",note).put("time",System.currentTimeMillis()),500)}
 fun ledger(c:Context):List<LedgerEvent>{val a=arr(c,"ledger");return(0 until a.length()).map{val o=a.getJSONObject(it);LedgerEvent(o.optString("type"),o.optLong("amount"),o.optString("note"),o.optLong("time"))}.reversed()}
 fun recordPurchase(c:Context,v:VehicleSnapshot,amount:Long){append(c,"deals",JSONObject().put("id",(v.plate.ifBlank{v.name})+"|"+System.currentTimeMillis()).put("name",v.name).put("plate",v.plate).put("buy",amount).put("fees",0).put("opened",System.currentTimeMillis()));addLedger(c,"ПОКУПКА",-amount,v.name)}
 fun recordSale(c:Context,v:VehicleSnapshot,amount:Long){val a=arr(c,"deals");var idx=-1;for(i in a.length()-1 downTo 0){val o=a.optJSONObject(i)?:continue;if(!o.has("sell")&&((v.plate.isNotEmpty()&&o.optString("plate")==v.plate)||(v.plate.isEmpty()&&o.optString("name")==v.name))){idx=i;break}};var profit:Long?=null;if(idx>=0){val o=a.getJSONObject(idx);profit=amount-o.optLong("buy")-o.optLong("fees");o.put("sell",amount).put("closed",System.currentTimeMillis())}else a.put(JSONObject().put("id",(v.plate.ifBlank{v.name})+"|"+System.currentTimeMillis()).put("name",v.name).put("plate",v.plate).put("sell",amount).put("fees",0).put("opened",System.currentTimeMillis()).put("closed",System.currentTimeMillis()));while(a.length()>200)a.remove(0);p(c).edit().putString("deals",a.toString()).apply();if(profit!=null){LearningMemory.recordAllActionOutcomes(c,v,amount,"",v.plate);LearningMemory.learn(c,v,profit);addEvent(c,"ОБУЧЕНИЕ • продажа "+amount+" ₽ • прибыль "+profit+" ₽")};addLedger(c,"ПРОДАЖА",amount,v.name)}
 fun addFee(c:Context,amount:Long,note:String){addLedger(c,"РАСХОД",-amount,note)}
 fun deals(c:Context):List<Deal>{val a=arr(c,"deals");return(0 until a.length()).map{val o=a.getJSONObject(it);Deal(o.optString("id"),o.optString("name"),o.optString("plate"),if(o.has("buy"))o.optLong("buy")else null,if(o.has("sell"))o.optLong("sell")else null,o.optLong("fees"),o.optLong("opened"),if(o.has("closed"))o.optLong("closed")else null)}.reversed()}
 fun savePlateBid(c:Context,plate:String,amount:Long,buyer:String="",source:String=""){if(plate.isBlank()||amount<=0)return;append(c,"plate_bids",JSONObject().put("plate",plate).put("amount",amount).put("buyer",buyer).put("source",source).put("time",System.currentTimeMillis()))}
 fun plateBids(c:Context,plate:String=""):List<String>{val a=arr(c,"plate_bids");return(0 until a.length()).mapNotNull{val o=a.optJSONObject(it)?:return@mapNotNull null;if(plate.isNotBlank()&&o.optString("plate")!=plate)return@mapNotNull null;"• "+o.optString("plate")+" → "+o.optLong("amount")+" ₽"}.reversed()}
 fun hasPlateBid(c:Context,plate:String,amount:Long)=plateBids(c,plate).any{it.contains("→ $amount ₽")}
 fun plateBestBid(c:Context,plate:String):Long?{val a=arr(c,"plate_bids");var b:Long?=null;for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optString("plate")==plate){val n=o.optLong("amount");if(n>0&&(b==null||n>b!!))b=n}};return b}
 fun savePlateAuction(c:Context,plate:String,status:String,startingPrice:Long?=null,currentBid:Long?=null,finalPrice:Long?=null,fees:Long=0){val o=JSONObject().put("plate",plate).put("status",status).put("fees",fees).put("updated",System.currentTimeMillis());startingPrice?.let{o.put("starting_price",it)};currentBid?.let{o.put("current_bid",it)};finalPrice?.let{o.put("final_price",it)};p(c).edit().putString("plate_auction:"+plate,o.toString()).apply()}
 fun plateAuction(c:Context,plate:String)=try{JSONObject(p(c).getString("plate_auction:"+plate,"{}"))}catch(_:Exception){JSONObject()}
 fun setPlateCost(c:Context,plate:String,cost:Long){p(c).edit().putLong("plate_cost:"+plate,cost).apply()}
 fun plateCost(c:Context,plate:String):Long?{val k="plate_cost:"+plate;return if(p(c).contains(k))p(c).getLong(k,0)else null}
 fun plateNetResult(c:Context,plate:String):Long?{val a=plateAuction(c,plate);if(!a.has("final_price"))return null;val cost=plateCost(c,plate)?:return null;return a.optLong("final_price")-cost-a.optLong("fees")}
 fun plateRoi(c:Context,plate:String):Double?{val cost=plateCost(c,plate)?:return null;if(cost<=0)return null;return (plateNetResult(c,plate)?:return null).toDouble()/cost*100}
 fun plateAuctionMarginPercent(c:Context,plate:String):Double?{val a=plateAuction(c,plate);val base=a.optLong("starting_price",0);val finalPrice=if(a.has("final_price"))a.optLong("final_price")else plateBestBid(c,plate)?:return null;return if(base>0)(finalPrice-a.optLong("fees")-base).toDouble()/base*100 else null}
 fun plateAuctionRoi(c:Context,plate:String)=plateRoi(c,plate)
 fun recordPlateSale(c:Context,plate:String,amount:Long){val a=plateAuction(c,plate);savePlateAuction(c,plate,"SOLD",if(a.has("starting_price"))a.optLong("starting_price")else null,plateBestBid(c,plate),amount,a.optLong("fees"))}
 fun setPlate(c:Context,plate:String,state:String,value:Long?=null){if(plate.isBlank())return;val o=JSONObject().put("plate",plate).put("state",state).put("updated",System.currentTimeMillis());value?.let{o.put("value",it)};p(c).edit().putString("plate:"+plate,o.toString()).apply()}
 fun plateValue(c:Context,plate:String):Long?{val o=try{JSONObject(p(c).getString("plate:"+plate,"{}"))}catch(_:Exception){JSONObject()};return if(o.has("value"))o.optLong("value")else plateBestBid(c,plate)}
 fun plates(c:Context):List<PlateRecord>{val all=p(c).all.keys.filter{it.startsWith("plate:")};return all.mapNotNull{val o=try{JSONObject(p(c).getString(it,"{}"))}catch(_:Exception){return@mapNotNull null};PlateRecord(o.optString("plate"),o.optString("state"),if(o.has("value"))o.optLong("value")else null,o.optLong("updated"))}.sortedByDescending{it.updated}}
}