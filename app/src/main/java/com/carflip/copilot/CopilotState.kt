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
 fun saveForecast(c:Context,sale:Long?,profit:Long?,roi:Double?,confidence:Int?){
  val o=JSONObject();sale?.let{o.put("sale_price",it)};profit?.let{o.put("expected_profit",it)};roi?.let{o.put("roi_percent",it)};confidence?.let{o.put("confidence",it)}
  p(c).edit().putString("forecast",o.toString()).apply()
 }
 fun forecast(c:Context):String=p(c).getString("forecast","{}")?:"{}"
 fun dealForecast(c:Context,v:VehicleSnapshot):JSONObject{
  val sale=LearningMemory.estimatedSale(c,v,v.price)
  val open=deals(c).firstOrNull{it.closed==null&&(v.plate.isNotEmpty()&&it.plate==v.plate||v.plate.isEmpty()&&it.name==v.name)}
  val buy=open?.buy?:v.price?:0L; val fees=open?.fees?:0L
  val profit=sale?.minus(buy+fees)
  val roi=if(buy+fees>0&&profit!=null)profit.toDouble()/(buy+fees)*100.0 else null
  return JSONObject().put("sale_price",sale).put("purchase",buy).put("fees",fees).put("expected_profit",profit).put("roi_percent",roi)
 }
 fun saveActionRoi(c:Context,action:String,cost:Long,delta:Long,reason:String="",dealId:String="",plate:String="",beforeSale:Long?=null){
  append(c,"action_roi",JSONObject().put("key",action+"|"+cost+"|"+System.currentTimeMillis()/60000).put("action",action.take(120)).put("cost",cost).put("delta",delta).put("roi",roi(cost,delta)).put("reason",reason.take(400)).put("deal_id",dealId).put("plate",plate).put("before_sale",beforeSale).put("time",System.currentTimeMillis()))
 }
 fun actionRoi(c:Context):List<String>{val a=JSONArray(p(c).getString("action_roi","[]"));return(0 until a.length()).mapNotNull{val o=a.optJSONObject(it)?:return@mapNotNull null;"• "+o.optString("action")+" • "+o.optLong("cost")+" ₽ • ROI "+String.format("%.1f",o.optDouble("roi"))+"%"}.reversed()}
 fun addBuyerOffer(c:Context,plate:String,name:String,condition:String,amount:Long,buyer:String="",notes:String=""){append(c,"buyer_offers",JSONObject().put("key",(plate+"|"+condition+"|"+amount+"|"+buyer).hashCode().toString()).put("plate",plate).put("name",name).put("condition",condition.take(300)).put("amount",amount).put("buyer",buyer.take(200)).put("notes",notes.take(500)).put("time",System.currentTimeMillis()))}
 fun buyerOffers(c:Context,plate:String=""):List<String>{val a=JSONArray(p(c).getString("buyer_offers","[]"));return(0 until a.length()).mapNotNull{val o=a.optJSONObject(it)?:return@mapNotNull null;if(plate.isNotEmpty()&&o.optString("plate")!=plate)return@mapNotNull null;"• "+o.optString("condition")+" → "+o.optLong("amount")+" ₽"+(if(o.optString("buyer").isNotEmpty())" • "+o.optString("buyer") else "")}.reversed()}
 fun roi(cost:Long,delta:Long):Double=if(cost<=0)0.0 else (delta-cost).toDouble()/cost.toDouble()*100.0
 fun events(c:Context):List<String>{val a=JSONArray(p(c).getString("events","[]"));return(0 until a.length()).mapNotNull{a.optJSONObject(it)?.optString("text")}.reversed()}
 fun addLedger(c:Context,type:String,amount:Long?,note:String){if(amount==null)return;append(c,"ledger",JSONObject().put("key",(type+"|"+amount+"|"+note).hashCode().toString()).put("type",type).put("amount",amount).put("note",note.take(500)).put("time",System.currentTimeMillis()))}
 fun ledger(c:Context):List<LedgerEvent>{val a=JSONArray(p(c).getString("ledger","[]"));return(0 until a.length()).map{val o=a.getJSONObject(it);LedgerEvent(o.optString("type"),o.optLong("amount"),o.optString("note"),o.optLong("time"))}.reversed()}
 fun recordPurchase(c:Context,v:VehicleSnapshot,amount:Long){val id=(v.plate.ifEmpty{v.name}).ifEmpty{"deal"}+"|"+System.currentTimeMillis();val o=JSONObject().put("id",id).put("name",v.name).put("plate",v.plate).put("buy",amount).put("fees",0L).put("opened",System.currentTimeMillis());append(c,"deals",o);addLedger(c,"ПОКУПКА",-amount,v.name.ifEmpty{"авто"})}
 fun recordSale(c:Context,v:VehicleSnapshot,amount:Long){val a=JSONArray(p(c).getString("deals","[]"));var idx=-1;for(i in a.length()-1 downTo 0){val o=a.optJSONObject(i)?:continue;if(!o.has("sell")&&((v.plate.isNotEmpty()&&o.optString("plate")==v.plate)||(v.plate.isEmpty()&&o.optString("name")==v.name))){idx=i;break}};var learnedProfit:Long?=null;if(idx>=0){val existing=a.getJSONObject(idx);val buy=if(existing.has("buy"))existing.optLong("buy") else 0L;val fees=existing.optLong("fees");learnedProfit=amount-buy-fees;a.put(idx,existing.put("sell",amount).put("closed",System.currentTimeMillis()))}else{a.put(JSONObject().put("id",(v.plate.ifEmpty{v.name})+"|"+System.currentTimeMillis()).put("name",v.name).put("plate",v.plate).put("sell",amount).put("fees",0L).put("opened",System.currentTimeMillis()).put("closed",System.currentTimeMillis()))};while(a.length()>200)a.remove(0);p(c).edit().putString("deals",a.toString()).apply();learnedProfit?.let{profit-> val closed=a.optJSONObject(idx)?.optString("id")?:""; LearningMemory.recordAllActionOutcomes(c,v,amount,closed,v.plate); LearningMemory.learn(c,v,profit); calibrateActionRoi(c,v,profit); addEvent(c,"ОБУЧЕНИЕ • продажа "+amount+" ₽ • прибыль "+profit+" ₽ • действия откалиброваны • "+v.name)};addLedger(c,"ПРОДАЖА",amount,v.name.ifEmpty{"авто"})}\n fun calibrateActionRoi(c:Context,v:VehicleSnapshot,profit:Long){val a=JSONArray(p(c).getString("action_roi","[]"));val hist=JSONArray(p(c).getString("action_calibration","[]"));val dealId=deals(c).firstOrNull{it.closed==null||it.plate==v.plate||it.name==v.name}?.id?:"";for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optString("deal_id").isNotEmpty()&&dealId.isNotEmpty()&&o.optString("deal_id")!=dealId)continue;if(o.optString("plate").isNotEmpty()&&v.plate.isNotEmpty()&&o.optString("plate")!=v.plate)continue;hist.put(JSONObject().put("action",ActionRoiEngine.normalize(o.optString("action"))).put("expected_delta",o.optLong("delta")).put("realized_profit",profit).put("deal_id",dealId).put("time",System.currentTimeMillis()))};while(hist.length()>500)hist.remove(0);p(c).edit().putString("action_calibration",hist.toString()).apply()}
 fun addFee(c:Context,amount:Long,note:String){val a=JSONArray(p(c).getString("deals","[]"));for(i in a.length()-1 downTo 0){val o=a.optJSONObject(i)?:continue;if(!o.has("closed")){o.put("fees",o.optLong("fees")+amount);break}};p(c).edit().putString("deals",a.toString()).apply();addLedger(c,"РАСХОД",-amount,note)}
 fun savePlateBid(c:Context,plate:String,amount:Long,buyer:String="",source:String=""){if(plate.isBlank()||amount<=0)return;append(c,"plate_bids",JSONObject().put("key",(plate+"|"+amount+"|"+buyer+"|"+System.currentTimeMillis()/5000).hashCode().toString()).put("plate",plate).put("amount",amount).put("buyer",buyer.take(200)).put("source",source.take(100)).put("time",System.currentTimeMillis()))}
 fun plateBids(c:Context,plate:String=""):List<String>{val a=JSONArray(p(c).getString("plate_bids","[]"));return(0 until a.length()).mapNotNull{val o=a.optJSONObject(it)?:return@mapNotNull null;if(plate.isNotEmpty()&&o.optString("plate")!=plate)return@mapNotNull null;"• "+o.optString("plate")+" → "+o.optLong("amount")+" ₽"+(if(o.optString("buyer").isNotEmpty())" • "+o.optString("buyer") else "")}.reversed()}
 fun hasPlateBid(c:Context,plate:String,amount:Long):Boolean{if(plate.isBlank()||amount<=0)return false;val a=JSONArray(p(c).getString("plate_bids","[]"));for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optString("plate")==plate&&o.optLong("amount",0)==amount)return true};return false}
 fun plateBestBid(c:Context,plate:String):Long?{val a=JSONArray(p(c).getString("plate_bids","[]"));var best:Long?=null;for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optString("plate")==plate){val n=o.optLong("amount",0);if(n>0&&(best==null||n>best!!))best=n}};return best}
 fun savePlateAuction(c:Context,plate:String,status:String,startingPrice:Long?=null,currentBid:Long?=null,finalPrice:Long?=null,fees:Long=0){if(plate.isBlank())return;val o=JSONObject().put("plate",plate).put("status",status).put("updated",System.currentTimeMillis());startingPrice?.let{o.put("starting_price",it)};currentBid?.let{o.put("current_bid",it)};finalPrice?.let{o.put("final_price",it)};o.put("fees",fees);p(c).edit().putString("plate_auction:"+plate,o.toString()).apply()}
 fun plateAuction(c:Context,plate:String):JSONObject{val raw=p(c).getString("plate_auction:"+plate,"{}")?:"{}";return try{JSONObject(raw)}catch(_:Exception){JSONObject()}}
 fun setPlateCost(c:Context,plate:String,cost:Long){if(plate.isBlank()||cost<0)return;p(c).edit().putLong("plate_cost:"+plate,cost).apply()}
 fun plateCost(c:Context,plate:String):Long?{val prefs=p(c);val key="plate_cost:"+plate;if(!prefs.contains(key))return null;return prefs.getLong(key,0)}
 fun plateNetResult(c:Context,plate:String):Long?{val a=plateAuction(c,plate);val sale=if(a.has("final_price"))a.optLong("final_price")else return null;val cost=plateCost(c,plate)?:return null;return sale-cost-a.optLong("fees",0)}
 fun plateRoi(c:Context,plate:String):Double?{val cost=plateCost(c,plate)?:return null;if(cost<=0)return null;val net=plateNetResult(c,plate)?:return null;return net.toDouble()/cost*100.0}
 fun plateAuctionMarginPercent(c:Context,plate:String):Double?{val a=plateAuction(c,plate);val finalPrice=if(a.has("final_price"))a.optLong("final_price")else plateBestBid(c,plate)?:return null;val fees=a.optLong("fees",0);val base=if(a.has("starting_price"))a.optLong("starting_price")else 0L;return if(base>0)(finalPrice-fees-base).toDouble()/base*100.0 else null}
 fun plateAuctionRoi(c:Context,plate:String):Double?=plateRoi(c,plate)
 fun savePlateOffer(c:Context,plate:String,name:String,amount:Long,buyer:String="",notes:String=""){if(plate.isBlank()||amount<=0)return;append(c,"plate_offers",JSONObject().put("key",(plate+"|"+amount+"|"+buyer).hashCode().toString()).put("plate",plate).put("name",name).put("amount",amount).put("buyer",buyer.take(200)).put("notes",notes.take(500)).put("time",System.currentTimeMillis()))}
 fun plateOffers(c:Context,plate:String=""):List<String>{val a=JSONArray(p(c).getString("plate_offers","[]"));return(0 until a.length()).mapNotNull{val o=a.optJSONObject(it)?:return@mapNotNull null;if(plate.isNotEmpty()&&o.optString("plate")!=plate)return@mapNotNull null;"• "+o.optString("plate")+" → "+o.optLong("amount")+" ₽"+(if(o.optString("buyer").isNotEmpty())" • "+o.optString("buyer") else "")}.reversed()}
 fun recordPlateSale(c:Context,plate:String,amount:Long){if(plate.isBlank()||amount<=0)return;setPlate(c,plate,"ПРОДАН",amount);addLedger(c,"ПРОДАЖА НОМЕРА",amount,plate);addEvent(c,"НОМЕР • "+plate+" • отдельная продажа "+amount+" ₽");val a=JSONArray(p(c).getString("plate_offers","[]"));for(i in a.length()-1 downTo 0){val o=a.optJSONObject(i)?:continue;if(o.optString("plate")==plate&&!o.has("sold")){o.put("sold",amount).put("soldTime",System.currentTimeMillis());a.put(i,o);break}};p(c).edit().putString("plate_offers",a.toString()).apply()}
 fun plateValue(c:Context,plate:String):Long?{val rec=plates(c).firstOrNull{it.plate==plate};val offers=plateOffers(c,plate);return rec?.value?:if(offers.isNotEmpty())offers.firstOrNull()?.substringAfter("→")?.replace(Regex("[^0-9]"),"")?.toLongOrNull() else null}
 fun setPlate(c:Context,plate:String,state:String,value:Long?=null){if(plate.isBlank())return;val a=JSONArray(p(c).getString("plates","[]"));var idx=-1;for(i in 0 until a.length())if(a.optJSONObject(i)?.optString("plate")==plate){idx=i;break};val o=JSONObject().put("plate",plate).put("state",state).put("updated",System.currentTimeMillis());value?.let{o.put("value",it)};if(idx>=0)a.put(idx,o)else a.put(o);while(a.length()>100)a.remove(0);p(c).edit().putString("plates",a.toString()).apply()}
 fun plates(c:Context):List<PlateRecord>{val a=JSONArray(p(c).getString("plates","[]"));return(0 until a.length()).map{val o=a.getJSONObject(it);PlateRecord(o.optString("plate"),o.optString("state"),if(o.has("value"))o.optLong("value")else null,o.optLong("updated"))}.reversed()}
 fun deals(c:Context):List<Deal>{val a=JSONArray(p(c).getString("deals","[]"));return(0 until a.length()).map{val o=a.getJSONObject(it);Deal(o.optString("id"),o.optString("name"),o.optString("plate"),if(o.has("buy"))o.optLong("buy")else null,if(o.has("sell"))o.optLong("sell")else null,o.optLong("fees"),o.optLong("opened"),if(o.has("closed"))o.optLong("closed")else null)}.reversed()}
}
