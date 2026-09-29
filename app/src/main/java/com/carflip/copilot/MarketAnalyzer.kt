package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

data class MarketCandidate(
    val key:String,
    val name:String,
    val price:Long,
    val hp:Int?,
    val mileage:Long?,
    val owners:Int?,
    val paintedParts:Int?,
    val plate:String,
    val origin:String,
    val expectedSale:Long?,
    val fees:Long,
    val expectedProfit:Long?,
    val roi:Double?,
    val risk:Int,
    val confidence:Int,
    val updatedAt:Long
)

object MarketAnalyzer {
    private const val PREF = "copilot_market"
    private const val CANDIDATES = "candidates"
    private const val MAX = 80

    private fun p(c:Context)=c.getSharedPreferences(PREF,Context.MODE_PRIVATE)
    private fun norm(s:String)=s.lowercase().replace('ё','е').replace(Regex("\\s+")," ").trim()
    private fun arr(c:Context)=try{JSONArray(p(c).getString(CANDIDATES,"[]"))}catch(_:Exception){JSONArray()}

    private fun history(c:Context,name:String):List<Deal>{
        val target=norm(name)
        return CopilotState.deals(c).filter{norm(it.name)==target && it.buy!=null && it.sell!=null}
    }

    private fun tokens(name:String):Set<String> =
        norm(name).split(Regex("[^a-zа-я0-9]+")).filter{it.length>=3}.toSet()

    private fun similarHistory(c:Context,name:String):List<Deal>{
        val target=tokens(name)
        if(target.isEmpty()) return emptyList()
        return CopilotState.deals(c).filter{d->
            d.sell!=null && tokens(d.name).let{other->
                val common=target.intersect(other).size
                common>=2 || (target.size==1 && common==1)
            }
        }
    }

    private fun saleEstimate(c:Context,v:VehicleSnapshot,exact:List<Deal>):Pair<Long?,Int>{
        if(exact.isNotEmpty()) return Pair(exact.mapNotNull{it.sell}.average().toLong(), min(90,60+exact.size*10))
        val similar=similarHistory(c,v.name)
        if(similar.isEmpty()) return Pair(null,45)
        val sales=similar.mapNotNull{it.sell}
        if(sales.isEmpty()) return Pair(null,45)
        val estimate=sales.average().toLong()
        return Pair(estimate,min(72,45+similar.size*7))
    }

    fun observe(c:Context,v:VehicleSnapshot,screen:String){
        if(v.name.isBlank() || v.price==null || v.price<=0L) return
        val s=norm(screen)
        if(!(s.contains("покуп")||s.contains("авто")||s.contains("рын")||s.contains("market"))) return

        val h=history(c,v.name)
        val sale= saleEstimate(c,v,h)
        val expected=sale.first
        val baseline=expected
        val currentDeal=CopilotState.deals(c).firstOrNull{norm(it.name)==norm(v.name) && it.buy==v.price && it.sell==null}
        val fees=currentDeal?.fees?:0L
        val profit=baseline?.let{it-v.price-fees}
        val roi=profit?.let{if(v.price>0)it.toDouble()/v.price*100.0 else null}

        var risk=0
        if(v.mileage!=null){
            risk += when {
                v.mileage>=200000 -> 28
                v.mileage>=150000 -> 20
                v.mileage>=100000 -> 12
                v.mileage>=70000 -> 6
                else -> 0
            }
        } else risk += 8
        if(v.owners!=null) risk += max(0,(v.owners-2)*5) else risk += 4
        if(v.paintedParts!=null) risk += min(20,v.paintedParts*4) else risk += 3
        if(expected==null) risk += 22 else if(h.isEmpty()) risk += 12
        risk=min(100,risk)

        val confidence=min(95,sale.second + if(v.mileage!=null)5 else 0 + if(v.owners!=null)5 else 0 + if(v.paintedParts!=null)3 else 0)\n        val capital=CapitalAnalyzer.profile(c,v.price,fees,v.name)
        val key=norm(v.name)+"|"+v.price+"|"+v.plate
        val o=JSONObject().put("key",key).put("name",v.name).put("price",v.price)
            .put("plate",v.plate).put("origin",v.origin).put("fees",fees).put("risk",risk)
            .put("confidence",confidence).put("capitalLocked",capital.locked).put("capitalUtilizationPercent",capital.utilizationPercent).put("holdingDaysEstimate",capital.holdingDays).put("turnoverConfidence",capital.turnoverConfidence).put("capitalPressure",capital.pressure).put("garagePressure",capital.garagePressure).put("updatedAt",System.currentTimeMillis())
        v.hp?.let{o.put("hp",it)}
        v.mileage?.let{o.put("mileage",it)}
        v.owners?.let{o.put("owners",it)}
        v.paintedParts?.let{o.put("paintedParts",it)}
        expected?.let{o.put("expectedSale",it)}
        profit?.let{o.put("expectedProfit",it)}
        roi?.let{o.put("roi",it)}

        val a=arr(c)
        var replaced=false
        for(i in 0 until a.length()){
            val old=a.optJSONObject(i)?:continue
            if(old.optString("key")==key){a.put(i,o);replaced=true;break}
        }
        if(!replaced)a.put(o)
        while(a.length()>MAX)a.remove(0)
        p(c).edit().putString(CANDIDATES,a.toString()).apply()
    }

    fun candidates(c:Context):List<MarketCandidate>{
        val a=arr(c)
        return (0 until a.length()).mapNotNull{
            val o=a.optJSONObject(it)?:return@mapNotNull null
            MarketCandidate(
                o.optString("key"),o.optString("name"),o.optLong("price"),
                if(o.has("hp"))o.optInt("hp")else null,
                if(o.has("mileage"))o.optLong("mileage")else null,
                if(o.has("owners"))o.optInt("owners")else null,
                if(o.has("paintedParts"))o.optInt("paintedParts")else null,
                o.optString("plate"),o.optString("origin"),
                if(o.has("expectedSale"))o.optLong("expectedSale")else null,
                o.optLong("fees",0L),
                if(o.has("expectedProfit"))o.optLong("expectedProfit")else null,
                if(o.has("roi"))o.optDouble("roi")else null,
                o.optInt("risk",50),o.optInt("confidence",45),o.optLong("capitalLocked",o.optLong("price")),o.optDouble("capitalUtilizationPercent",0.0),if(o.has("holdingDaysEstimate")&&!o.isNull("holdingDaysEstimate"))o.optDouble("holdingDaysEstimate")else null,o.optInt("turnoverConfidence",0),o.optInt("capitalPressure",50),o.optInt("garagePressure",0),o.optLong("updatedAt")
            )
        }.sortedByDescending{score(it)}
    }

    private fun score(x:MarketCandidate):Double{
        val profit= x.expectedProfit ?: 0L
        val roi=x.roi ?: -100.0
        return profit.toDouble()/max(1L,x.price)*100.0 + roi*0.7 - x.risk*0.8 + x.confidence*0.25
    }

    fun best(c:Context):MarketCandidate?=candidates(c).firstOrNull{it.expectedProfit!=null && it.expectedProfit>0 && it.capitalPressure<90 && it.garagePressure<100}

    fun snapshot(c:Context):JSONObject{
        val list=candidates(c)
        val out=JSONArray()
        list.take(10).forEach{v->
            out.put(JSONObject().put("name",v.name).put("price",v.price).put("expected_sale",v.expectedSale)
                .put("fees",v.fees).put("expected_profit",v.expectedProfit).put("roi_percent",v.roi)
                .put("risk",v.risk).put("confidence",v.confidence).put("capital_locked",v.capitalLocked).put("capital_utilization_percent",v.capitalUtilizationPercent).put("holding_days_estimate",v.holdingDaysEstimate).put("turnover_confidence",v.turnoverConfidence).put("capital_pressure",v.capitalPressure).put("garage_pressure",v.garagePressure).put("plate",v.plate)
                .put("mileage",v.mileage).put("owners",v.owners).put("painted_parts",v.paintedParts))
        }
        val b=best(c)
        return JSONObject().put("count",list.size).put("candidates",out)
            .put("best",b?.let{JSONObject().put("name",it.name).put("price",it.price).put("expected_sale",it.expectedSale).put("fees",it.fees)
                .put("expected_profit",it.expectedProfit).put("roi_percent",it.roi)
                .put("risk",it.risk).put("confidence",it.confidence).put("capital_locked",it.capitalLocked).put("capital_utilization_percent",it.capitalUtilizationPercent).put("holding_days_estimate",it.holdingDaysEstimate).put("turnover_confidence",it.turnoverConfidence).put("capital_pressure",it.capitalPressure).put("garage_pressure",it.garagePressure).put("plate",it.plate)})
            .put("source","observed_market_history")
    }
}
