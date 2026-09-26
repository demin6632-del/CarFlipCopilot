package com.carflip.copilot

data class Opportunity(
 val action:String,
 val title:String,
 val reason:String,
 val confidence:Int=0,
 val forecast:PlanForecast?=null,
 val alternatives:List<String> = emptyList()
)

object OpportunityAnalyzer {
 fun analyze(context:android.content.Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):Opportunity {
  val plan=DecisionPlanner.plan(context,text,v,balance,garage)
  val p=plan.first()
  LearningMemory.setCurrentSituation(context,listOf(p.action,v.name.isNotBlank(),balance!=null,garage?:-1).joinToString("|"))
  return Opportunity(p.action,p.title,p.reason,p.score,p.forecast,plan.drop(1).take(3).map{it.action+": "+it.title})
 }
}