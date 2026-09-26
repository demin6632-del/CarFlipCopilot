package com.carflip.copilot

import android.content.Context
import android.graphics.Bitmap
import android.util.Base64
import okhttp3.*
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

class LiveBridge(private val context: Context, private val onCommand: (String) -> Unit, private val onChat: (String) -> Unit = {}) {
    private val prefs=context.getSharedPreferences("live_bridge",Context.MODE_PRIVATE)
    private var client:OkHttpClient?=null
    private var socket:WebSocket?=null
    @Volatile private var connected=false

    fun configure(url:String, token:String){
        prefs.edit().putString("url",url.trim()).putString("token",token.trim()).apply()
    }
    fun url():String=prefs.getString("url","")?:""
    fun token():String=prefs.getString("token","")?:""
    fun isConnected():Boolean=connected

    fun start(){
        val u=url(); if(u.isBlank()) return
        stop()
        client=OkHttpClient.Builder().readTimeout(0,TimeUnit.MILLISECONDS).pingInterval(15,TimeUnit.SECONDS).build()
        val req=Request.Builder().url(u).header("Authorization","Bearer "+token()).build()
        socket=client!!.newWebSocket(req,object:WebSocketListener(){
            override fun onOpen(ws:WebSocket,response:Response){connected=true; send(JSONObject().put("type","hello").put("device","android").put("app","CarFlipCopilot").toString())}
            override fun onMessage(ws:WebSocket,text:String){try{val o=JSONObject(text);when(o.optString("type")){"command"->onCommand(o.optString("command"));"chat"->onChat(o.optString("message"))}}catch(_:Exception){}}
            override fun onClosed(ws:WebSocket,code:Int,reason:String){connected=false}
            override fun onFailure(ws:WebSocket,t:Throwable,response:Response?){connected=false}
        })
    }
    fun sendState(text:String, v:VehicleSnapshot, balance:Long, garage:Int, decision:String, opportunity:Opportunity){
        if(!connected)return
        val o=JSONObject().put("type","state").put("time",System.currentTimeMillis())
            .put("ocr",text).put("balance",balance).put("garage",garage).put("decision",decision)
            .put("action",opportunity.action).put("confidence",opportunity.confidence)
            .put("title",opportunity.title).put("reason",opportunity.reason)
            .put("vehicle",JSONObject().put("name",v.name).put("price",v.price).put("hp",v.hp)
                .put("mileage",v.mileage).put("owners",v.owners).put("plate",v.plate)
                .put("origin",v.origin).put("paintedParts",v.paintedParts))
        send(o.toString())
    }
    fun sendGameState(state:GameState, opportunity:GameOpportunity){
        if(!connected)return
        val p=state.player
        val o=JSONObject().put("type","game_state").put("time",System.currentTimeMillis())
            .put("activeSection",state.activeSection).put("lastEvent",state.lastEvent)
            .put("player",JSONObject().put("level",p.level).put("xp",p.xp).put("xpMax",p.xpMax)
                .put("respect",p.respect).put("balance",p.balance).put("garageUsed",p.garageUsed).put("garageCapacity",p.garageCapacity)
                .put("creditStatus",p.creditStatus).put("vip",p.vip))
            .put("opportunity",JSONObject().put("action",opportunity.action).put("section",opportunity.section)
                .put("title",opportunity.title).put("reason",opportunity.reason).put("expectedValue",opportunity.expectedValue)
                .put("confidence",opportunity.confidence))
            .put("vehicle",JSONObject().put("name",state.vehicle.name).put("price",state.vehicle.price)
                .put("hp",state.vehicle.hp).put("mileage",state.vehicle.mileage).put("paintedParts",state.vehicle.paintedParts)
                .put("stage",state.vehicle.stage).put("invested",state.vehicle.invested).put("polishApplied",state.vehicle.polishApplied))
        send(o.toString())
    }
    fun sendFrame(bitmap:Bitmap){
        if(!connected)return
        val out=ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG,55,out)
        val b64=Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP)
        send(JSONObject().put("type","frame").put("time",System.currentTimeMillis()).put("jpegBase64",b64).toString())
    }
    fun sendChat(message:String,source:String="copilot"){if(!connected)return;send(JSONObject().put("type","chat").put("source",source).put("message",message).put("time",System.currentTimeMillis()).toString())}
    private fun send(s:String){socket?.send(s)}
    fun stop(){socket?.close(1000,"stop");socket=null;connected=false;client?.dispatcher?.executorService?.shutdown();client=null}
}
