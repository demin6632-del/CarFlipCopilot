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
    private val actions=listOf("ЧИП","ТУРБИНА","ПОЛИРОВКА","ОКРАСКА","РЕМОНТ","ДИАГНОСТИКА","НИЧЕГО НЕ ДЕЛАТЬ")

    fun evaluate(c:Context,v:VehicleSnapshot):List<ActionOption> {
        return actions.map { action ->
            if(action=="НИЧЕГО НЕ ДЕЛАТЬ") {
                ActionOption(action,0L,0L,0.0,60,0,"Базовый сценарий: не тратить деньги и сохранить текущую маржу.")
            } else {
                val s=LearningMemory.actionSummary(c,v,action)
                val delta=s.avgRealizedDelta ?: s.avgStateDelta ?: s.avgExpectedDelta
                val roi=s.realizedRoi ?: s.expectedRoi
                val reason=when {
                    s.realizedSamples>0 -> "Факт: ${s.realizedSamples} завершённых результатов; учитывается средний реализованный эффект."
                    s.avgStateDelta!=null -> "Есть realtime-эффект после действия; ждём продажу для окончательной калибровки."
                    s.samples>0 -> "Есть история действия, но пока нет подтверждённого результата."
                    else -> "Недостаточно данных: сначала нужно увидеть стоимость и эффект действия в игре."
                }
                ActionOption(action,s.avgCost,delta,roi,s.confidence,s.samples,reason)
            }
        }
    }

    fun best(c:Context,v:VehicleSnapshot):ActionOption {
        val options=evaluate(c,v)
        return options.maxWithOrNull(compareBy<ActionOption>{ score(it) }.thenBy{ it.confidence }) ?: options.last()
    }

    fun score(o:ActionOption):Double {
        if(o.action=="НИЧЕГО НЕ ДЕЛАТЬ") return 0.0
        val roi=o.roi ?: return -1.0
        val confidenceFactor=(o.confidence.coerceIn(20,90)/90.0)
        return roi*confidenceFactor
    }
}
