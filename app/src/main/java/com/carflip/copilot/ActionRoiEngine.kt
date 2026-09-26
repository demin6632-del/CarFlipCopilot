package com.carflip.copilot

import android.content.Context
import org.json.JSONArray

data class ActionRoiResult(val action:String,val cost:Long,val expectedDelta:Long,val expectedProfitDelta:Long,val roiPercent:Double,val confidence:Int,val samples:Int,val learnedRoi:Double?)

object ActionRoiEngine {
    private val aliases = mapOf("чип" to "ЧИП","chip" to "ЧИП","турб" to "ТУРБИНА","turbo" to "ТУРБИНА","полиров" to "ПОЛИРОВКА","polish" to "ПОЛИРОВКА","окрас" to "ОКРАСКА","покрас" to "ОКРАСКА","paint" to "ОКРАСКА","ремонт" to "РЕМОНТ","repair" to "РЕМОНТ","диагност" to "ДИАГНОСТИКА","diagnostic" to "ДИАГНОСТИКА")
    fun normalize(action:String):String {
        val s=action.trim().lowercase()
        return aliases.entries.firstOrNull{s.contains(it.key)}?.value ?: action.trim().uppercase().take(80).ifBlank{"ДЕЙСТВИЕ"}
    }
    fun evaluate(c:Context,v:VehicleSnapshot,action:String,cost:Long,expectedDelta:Long):ActionRoiResult {
        val normalized=normalize(action); val learned=LearningMemory.actionRoi(c,v,normalized); val samples=LearningMemory.actionSamples(c,v,normalized)
        val roi=if(cost>0)(expectedDelta-cost).toDouble()/cost*100.0 else 0.0
        val confidence=when{samples>=10->90;samples>=5->80;samples>=2->68;else->45}
        return ActionRoiResult(normalized,cost,expectedDelta,expectedDelta,roi,confidence,samples,learned)
    }
    fun summary(c:Context,v:VehicleSnapshot):List<String> {
        val a=JSONArray(c.getSharedPreferences("copilot_learning",Context.MODE_PRIVATE).getString("action_history","[]")); val map=LinkedHashMap<String,MutableList<Double>>()
        for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;if(o.optString("feature")!=featureKey(v))continue;val action=normalize(o.optString("action"));map.getOrPut(action){mutableListOf()}.add(o.optDouble("roi"))}
        return map.entries.map{entry->"• "+entry.key+" • ROI "+String.format("%.1f",entry.value.average())+"% • "+entry.value.size+" реал."}.take(8)
    }
    fun learned(c:Context,v:VehicleSnapshot,action:String):LearningMemory.ActionLearningSummary = LearningMemory.actionSummary(c,v,normalize(action))
    fun learnedAdjustmentPercent(c:Context,v:VehicleSnapshot,action:String):Double {
        val s=learned(c,v,action);return when{ s.realizedRoi!=null -> s.realizedRoi; s.expectedRoi!=null -> s.expectedRoi; else -> 0.0 }
    }
    private fun featureKey(v:VehicleSnapshot):String {
        val origin=v.origin.ifBlank{"UNKNOWN"}; val hpBand=when{(v.hp?:0)>=600->"600+";(v.hp?:0)>=400->"400-599";(v.hp?:0)>=300->"300-399";else->"<300"}; val priceBand=when{(v.price?:Long.MAX_VALUE)<=1000000->"0-1m";(v.price?:Long.MAX_VALUE)<=2000000->"1-2m";(v.price?:Long.MAX_VALUE)<=2500000->"2-2.5m";else->"2.5m+"}; return "${origin}|${hpBand}|${priceBand}"
    }
}
