package com.carflip.copilot

import android.content.Context

object ChatBus { const val ACTION = "com.carflip.copilot.CHAT_MESSAGE" }

object ChatMemory {
 private const val PREF = "copilot_chat"
 fun add(c:Context, source:String, message:String) {
  val p=c.getSharedPreferences(PREF,0)
  val old=p.getString("history","") ?: ""
  val line=source+"\t"+message.replace("\n"," ")
  val items=(old.split("\n").filter{it.isNotBlank()}+line).takeLast(80)
  p.edit().putString("history",items.joinToString("\n")).apply()
 }
 fun read(c:Context):List<String> = (c.getSharedPreferences(PREF,0).getString("history","") ?: "").split("\n").filter{it.isNotBlank()}
}

object CopilotChatEngine {
 fun reply(c:Context,message:String):String {
  val q=message.trim().lowercase()
  val v=CopilotState.snapshot(c)
  val b=CopilotState.balance(c)
  val g=CopilotState.garage(c)
  val s=WholeGameState.read(c)
  if(q.contains("баланс")) return "Баланс: "+b+" ₽. Гараж: "+g+"/3."
  if(q.contains("где мы")||q.contains("раздел")) return "Сейчас раздел: "+s.activeSection.ifBlank{"не определён"}+"."
  if(q.contains("машин")||q.contains("авто")) return if(v.name.isBlank()) "Машина пока не распознана." else v.name+" • "+(v.hp?.toString()?:("мощность не известна"))+" л.с. • пробег "+(v.mileage?.toString()?:("неизвестен"))+" км."
  if(q.contains("что делать")||q.contains("что сейчас")) { val o=WholeGameOpportunityEngine.analyze(c,v.raw,v,b,g); return o.title+": "+o.reason }
  return "Принял. Я продолжаю следить за игрой. Спроси: «что делать сейчас», «баланс», «машина» или «где мы»."
 }
}