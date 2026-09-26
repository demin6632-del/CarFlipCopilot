package com.carflip.copilot

data class Opportunity(val action:String,val title:String,val reason:String,val confidence:Int=0)

object OpportunityAnalyzer {
 fun analyze(context:android.content.Context,text:String,v:VehicleSnapshot,balance:Long?,garage:Int?):Opportunity {
  val a=SituationEngine.advise(context,text,v,balance,garage)
  LearningMemory.setCurrentSituation(context,listOf(a.action,v.name.isNotBlank(),balance!=null,garage?:-1).joinToString("|"))
  return Opportunity(a.action,a.title,a.reason,a.confidence)
 }
}