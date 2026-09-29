package com.carflip.copilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

object DealEfficiencyAnalyzer {
    private fun completed(c: Context)=CopilotState.deals(c).filter{it.buy!=null&&it.sell!=null&&it.closed!=null&&it.opened>0L}
    private fun days(d: Deal): Double? {
        val end=d.closed?:return null
        if(end<=d.opened)return null
        return (end-d.opened).toDouble()/86_400_000.0
    }
    fun snapshot(c: Context): JSONObject {
        val ds=completed(c)
        val items=JSONArray()
        ds.takeLast(30).reversed().forEach{d->
            val profit=(d.sell?:0L)-(d.buy?:0L)-d.fees
            val capital=(d.buy?:0L)+d.fees
            val roi=if(capital>0)profit.toDouble()/capital*100.0 else 0.0
            val hold=days(d)
            val daily=if(hold!=null&&hold>0)profit.toDouble()/hold else null
            items.put(JSONObject().put("name",d.name).put("buy",d.buy).put("sell",d.sell).put("fees",d.fees)
                .put("profit",profit).put("capital_locked",capital).put("roi_percent",roi)
                .put("holding_days",hold).put("profit_per_day",daily))
        }
        val profits=ds.map{(it.sell?:0L)-(it.buy?:0L)-it.fees}
        val capitals=ds.map{(it.buy?:0L)+it.fees}.filter{it>0}
        val holds=ds.mapNotNull(::days)
        val totalProfit=profits.sum()
        val totalCapital=capitals.sum()
        val avgRoi=if(ds.isEmpty())null else profits.mapIndexed{idx,p->p.toDouble()/((ds[idx].buy?:0L)+ds[idx].fees).coerceAtLeast(1L)*100.0}.average()
        val avgHold=if(holds.isEmpty())null else holds.average()
        val avgDaily=if(ds.isEmpty()||holds.isEmpty())null else ds.mapNotNull{d->val h=days(d);if(h!=null&&h>0)((d.sell?:0L)-(d.buy?:0L)-d.fees).toDouble()/h else null}.average()
        return JSONObject().put("completed_deals",ds.size).put("total_profit",totalProfit)
            .put("average_roi_percent",avgRoi).put("average_holding_days",avgHold)
            .put("average_profit_per_day",avgDaily).put("total_capital_observed",totalCapital)
            .put("deals",items).put("source","completed_observed_deals")
    }
    fun candidateScore(c:Context,name:String,profit:Long,capital:Long,holdingDays:Double?):JSONObject {
        val roi=if(capital>0)profit.toDouble()/capital*100.0 else 0.0
        val daily=if(holdingDays!=null&&holdingDays>0)profit.toDouble()/holdingDays else null
        val base=snapshot(c)
        val avgDaily=if(base.has("average_profit_per_day")&&!base.isNull("average_profit_per_day"))base.optDouble("average_profit_per_day")else null
        val turnover=when {
            daily==null||avgDaily==null -> null
            avgDaily<=0 -> null
            else -> daily/avgDaily
        }
        return JSONObject().put("name",name).put("profit",profit).put("capital_locked",capital)
            .put("roi_percent",roi).put("profit_per_day",daily).put("turnover_vs_history",turnover)
    }
}
