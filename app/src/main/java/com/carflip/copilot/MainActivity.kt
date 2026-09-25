package com.carflip.copilot
import android.app.Activity\nimport android.app.AlertDialog
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.*
import android.provider.Settings
import android.widget.*
import androidx.appcompat.app.AppCompatActivity

class MainActivity:AppCompatActivity(){
 private val captureCode=1001;private lateinit var status:TextView;private lateinit var vehicle:TextView;private lateinit var history:TextView;private lateinit var tabs:TextView;private val handler=Handler(Looper.getMainLooper())
 private val refreshTask=object:Runnable{override fun run(){refresh();handler.postDelayed(this,1000)}}
 override fun onCreate(savedInstanceState:Bundle?){
  super.onCreate(savedInstanceState)
  val root=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(20,20,20,20)}
  val title=TextView(this).apply{text="🚗 Перекуп Copilot";textSize=28f}
  status=TextView(this).apply{textSize=16f;setPadding(0,14,0,12)}
  vehicle=TextView(this).apply{textSize=15f;setPadding(0,8,0,12)}
  tabs=TextView(this).apply{textSize=14f;setPadding(0,10,0,10)}
  history=TextView(this).apply{textSize=14f}
  val perm=Button(this).apply{text="Разрешить панель поверх Telegram";setOnClickListener{startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:"+packageName)))}}
  val start=Button(this).apply{text="Запустить мониторинг";setOnClickListener{requestCapture()}}
  val stop=Button(this).apply{text="Остановить мониторинг";setOnClickListener{stopService(Intent(this@MainActivity,ScreenMonitorService::class.java))}}\n  val api=Button(this).apply{text="Ключ командного доступа";setOnClickListener{val t=getSharedPreferences("copilot_state",0).getString("api_token",null) ?: "Ключ появится после запуска мониторинга"; AlertDialog.Builder(this@MainActivity).setTitle("Локальный API").setMessage("Адрес: 127.0.0.1:18765\\n\\nКлюч:\\n"+t+"\\n\\nДоступ ограничен localhost. Telegram приложение не управляется автоматически.").setPositiveButton("OK",null).show()}}
  root.addView(title);root.addView(status);root.addView(vehicle);root.addView(tabs);root.addView(perm);root.addView(start);root.addView(stop);root.addView(api);root.addView(history);setContentView(ScrollView(this).apply{addView(root)})
 }
 override fun onResume(){super.onResume();handler.post(refreshTask)};override fun onPause(){handler.removeCallbacks(refreshTask);super.onPause()}
 private fun fmt(v:Long)="%,d".format(v).replace(',',' ')
 private fun refresh(){
  val b=CopilotState.balance(this);val v=CopilotState.snapshot(this);val g=CopilotState.garage(this);val d=CopilotState.decision(this)
  status.text="Решение: "+d+"\nБаланс: "+fmt(b)+" ₽\nГараж: "+g+"/3\nМониторинг: "+if(CopilotState.monitoring(this))"ВКЛ" else "ВЫКЛ"
  vehicle.text=if(v.name.isEmpty())"Последняя машина: пока нет распознавания" else "Последняя машина:\n"+v.name+"\nЦена: "+(v.price?.let{fmt(it)+" ₽"}?:"—")+" • "+(v.hp?.let{it.toString()+" л.с."}?:"—")+"\nПроисхождение: "+v.origin.ifEmpty{"—"}+" • Крашеных: "+(v.paintedParts?.toString()?:"—")+"\nПробег: "+(v.mileage?.let{fmt(it)+" км"}?:"—")+" • Владельцев: "+(v.owners?:"—")+"\nНомер: "+v.plate.ifEmpty{"—"}
  val deals=CopilotState.deals(this).take(8).joinToString("\n"){x->val result=if(x.buy!=null&&x.sell!=null)"результат "+fmt(x.sell-x.buy-x.fees)+" ₽" else "открыта";"• "+x.name.ifEmpty{"Авто"}+" "+x.plate+" • "+(x.buy?.let{"куплено "+fmt(it)+" ₽"}?:"")+" "+(x.sell?.let{"продано "+fmt(it)+" ₽"}?:"")+" • расходы "+fmt(x.fees)+" ₽ • "+result}
  val ledger=CopilotState.ledger(this).take(10).joinToString("\n"){e->"• "+e.type+": "+fmt(e.amount?:0)+" ₽ "+e.note}
  val plates=CopilotState.plates(this).take(10).joinToString("\n"){x->"• "+x.plate+" — "+x.state+(x.value?.let{" • "+fmt(it)+" ₽"}?:"")}
  tabs.text="РАЗДЕЛЫ\nОбзор • Сделки • Расходы • Номера • События\n\nСделки:\n"+(if(deals.isEmpty())"пока нет" else deals)+"\n\nНомера:\n"+(if(plates.isEmpty())"пока нет" else plates)+"\n\nПоследние расходы/операции:\n"+(if(ledger.isEmpty())"пока нет" else ledger)
  history.text="\nСобытия:\n"+(CopilotState.events(this).take(12).joinToString("\n"){"• "+it}.ifEmpty{"пока пусто"})
 }
 private fun requestCapture(){if(!Settings.canDrawOverlays(this)){startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:"+packageName)));return};val mgr=getSystemService(MEDIA_PROJECTION_SERVICE)as MediaProjectionManager;startActivityForResult(mgr.createScreenCaptureIntent(),captureCode)}
 override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){super.onActivityResult(requestCode,resultCode,data);if(requestCode==captureCode&&resultCode==Activity.RESULT_OK&&data!=null)startForegroundService(Intent(this,ScreenMonitorService::class.java).putExtra("resultCode",resultCode).putExtra("data",data))}
}