package com.carflip.copilot

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.*
import androidx.appcompat.app.AppCompatActivity

class MainActivity:AppCompatActivity(){
    private val captureCode=1001
    private lateinit var status:TextView
    private lateinit var vehicle:TextView
    private lateinit var history:TextView
    private val handler=Handler(Looper.getMainLooper())
    private val refreshTask=object:Runnable{override fun run(){refresh();handler.postDelayed(this,1000)}}

    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState)
        val root=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(20,20,20,20)}
        val title=TextView(this).apply{text="🚗 Перекуп Copilot";textSize=28f}
        status=TextView(this).apply{textSize=16f;setPadding(0,14,0,12)}
        vehicle=TextView(this).apply{textSize=15f;setPadding(0,8,0,12)}
        history=TextView(this).apply{textSize=14f}
        val perm=Button(this).apply{text="Разрешить панель поверх Telegram";setOnClickListener{startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:"+packageName)))}}
        val start=Button(this).apply{text="Запустить мониторинг";setOnClickListener{requestCapture()}}
        val stop=Button(this).apply{text="Остановить мониторинг";setOnClickListener{stopService(Intent(this@MainActivity,ScreenMonitorService::class.java))}}
        root.addView(title);root.addView(status);root.addView(vehicle);root.addView(perm);root.addView(start);root.addView(stop);root.addView(history)
        setContentView(ScrollView(this).apply{addView(root)})
    }
    override fun onResume(){super.onResume();handler.post(refreshTask)}
    override fun onPause(){handler.removeCallbacks(refreshTask);super.onPause()}
    private fun fmt(v:Long)="%,d".format(v).replace(',',' ')
    private fun refresh(){
        val b=CopilotState.balance(this);val v=CopilotState.snapshot(this);val g=CopilotState.garage(this)
        status.text="Решение: "+CopilotState.decision(this)+"\nБаланс: "+fmt(b)+" ₽\nГараж: "+g+"/3\nКонтракт: Кинопродюсер\nUSA • ≥300 л.с. • ≤2 500 000 ₽ • +200 000 ₽"
        vehicle.text=if(v.name.isEmpty())"Последняя машина: пока нет распознавания" else "Последняя машина:\n"+v.name+"\nЦена: "+(v.price?.let{fmt(it)+" ₽"}?:"—")+" • "+(v.hp?.let{it.toString()+" л.с."}?:"—")+"\nПробег: "+(v.mileage?.let{fmt(it)+" км"}?:"—")+" • Владельцев: "+(v.owners?:"—")+"\nНомер: "+v.plate.ifEmpty{"—"}
        val led=CopilotState.ledger(this).take(12).joinToString("\n"){e->"• "+e.type+": "+(e.amount?.let{fmt(it)+" ₽"}?:"—")+" "+e.note}
        history.text="Журнал операций:\n"+(if(led.isEmpty())"пока пусто" else led)+"\n\nПоследние события:\n"+CopilotState.events(this).take(10).joinToString("\n"){"• "+it}
    }
    private fun requestCapture(){
        if(!Settings.canDrawOverlays(this)){startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:"+packageName)));return}
        val mgr=getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(mgr.createScreenCaptureIntent(),captureCode)
    }
    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){
        super.onActivityResult(requestCode,resultCode,data)
        if(requestCode==captureCode&&resultCode==Activity.RESULT_OK&&data!=null)startForegroundService(Intent(this,ScreenMonitorService::class.java).putExtra("resultCode",resultCode).putExtra("data",data))
    }
}
