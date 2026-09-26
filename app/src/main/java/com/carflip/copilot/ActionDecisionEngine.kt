package com.carflip.copilot

import android.content.Context

data class ActionOption(
    val action:String,
    val cost:Long?,
    val expectedDelta:Long?,
    val roi:Double?,
    val confidence:Int,
    val samples:Int,
    val reason:String
)

object ActionDecisionEngine {
    private val actions=listOf("ЧИП","ТУРБИНА","ПОЛИРОВКА","ОКРАСКА","РЕМОНТ","ДИАГНОСТИКА")

    fun evaluate(c:Context,v:VehicleSnapshot):List<ActionOption>{
        return actions.map { action ->
            val learned=LearningMemory.actionRoi(c,v,action)
            val samples=LearningMemory.actionSamples(c,v,action)
            val cost=knownCost(c,v,action)
            val delta=knownDelta(c,v,action)
            val roi=when {
                learned!=null -> learned
                cost!=null&&delta!=null&&cost>0 -> (delta-cost).toDouble()/cost*100.0
                else -> null
            }
            val confidence=when {
                samples>=10 -> 90
                samples>=5 -> 80
                samples>=2 -> 68
                learned!=null -> 55
                else -> 25
            }
            ActionOption(action,cost,delta,roi,confidence,samples,
                if(learned!=null) "Есть история по похожим машинам."
                else if(cost!=null&&delta!=null) "Расчёт по известным стоимости и приросту."
                else "Недостаточно данных: цену действия или эффект нужно увидеть в игре.")
        }
    }

    private fun knownCost(c:Context,v:VehicleSnapshot,a:String):Long? {
        val r=LearningMemory.actionRoi(c,v,a)
        return if(r!=null) null else null
    }

    private fun knownDelta(c:Context,v:VehicleSnapshot,a:String):Long? = null
}