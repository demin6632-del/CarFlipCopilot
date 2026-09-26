package com.carflip.copilot
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.*
import android.provider.Settings
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

class MainActivity:AppCompatActivity(){
 private val captureCode=1001
 private lateinit var status:TextView;private lateinit var vehicle:TextView;private lateinit var history:TextView;private lateinit var tabs:TextView;private lateinit var attachments:TextView
 private val handler=Handler(Looper.getMainLooper())
 private val refreshTask=object:Runnable{override fun run(){refresh();handler.postDelayed(this,1000)}}
 private val pickImage=registerForActivityResult(ActivityResultContracts.OpenDocument()){it?.let(::attach)}
 private val pickVideo=registerForActivityResult(ActivityResultContracts.OpenDocument()){it?.let(::attach)}
 private val pickFile=registerForActivityResult(ActivityResultContracts.OpenDocument()){it?.let(::attach)}

 override fun onCreate(savedInstanceState:Bundle?){
  super.onCreate(savedInstanceState)
  val root=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(20,20,20,20)}
  val title=TextView(this).apply{text="🚗 Перекуп Copilot";textSize=28f}
  status=TextView(this).apply{textSize=16f;setPadding(0,14,0,12)}
  vehicle=TextView(this).apply{textSize=15f;setPadding(0,8,0,12)}
  tabs=TextView(this).apply{textSize=14f;setPadding(0,10,0,10)}
  attachments=TextView(this).apply{textSize=14f;setPadding(0,8,0,12)}
  history=TextView(this).apply{textSize=14f}
  val perm=Button(this).apply{text="Разрешить панель поверх Telegram";setOnClickListener{startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:"+packageName)))}}
  val start=Button(this).apply{text="Запустить мониторинг";setOnClickListener{requestCapture()}}
  val stop=Button(this).apply{text="Остановить мониторинг";setOnClickListener{stopService(Intent(this@MainActivity,ScreenMonitorService::class.java))}}
  val bridge=Button(this).apply{text="Подключить меня к Copilot";setOnClickListener{showBridgeDialog()}}
  val image=Button(this).apply{text="📷 Фото / скриншот";setOnClickListener{pickImage.launch(arrayOf("image/*"))}}
  val video=Button(this).apply{text="🎥 Видео";setOnClickListener{pickVideo.launch(arrayOf("video/*"))}}
  val file=Button(this).apply{text="📎 Файл";setOnClickListener{pickFile.launch(arrayOf("*/*"))}}
  val api=Button(this).apply{text="Ключ командного доступа";setOnClickListener{val t=getSharedPreferences("copilot_state",0).getString("api_token",null) ?: "Ключ появится после запуска мониторинга";AlertDialog.Builder(this@MainActivity).setTitle("Локальный API").setMessage("Адрес: 127.0.0.1:18765\n\nКлюч:\n"+t+"\n\nДоступ ограничен localhost. Telegram приложение не управляется автоматически.").setPositiveButton("OK",null).show()}}
  root.addView(title);root.addView(status);root.addView(vehicle);root.addView(tabs);root.addView(perm);root.addView(start);root.addView(stop);root.addView(bridge);root.addView(image);root.addView(video);root.addView(file);root.addView(attachments);root.addView(api);root.addView(history)
  setContentView(ScrollView(this).apply{addView(root)});handleIncomingIntent(intent)
 }
 override fun onNewIntent(intent:Intent){super.onNewIntent(intent);setIntent(intent);handleIncomingIntent(intent)}
 override fun onResume(){super.onResume();handler.post(refreshTask)}
 override fun onPause(){handler.removeCallbacks(refreshTask);super.onPause()}
 private fun fmt(v:Long)="%,d".format(v).replace(',',' ')
 private fun attach(uri:Uri){
  val p=getSharedPreferences("live_bridge",0);val url=p.getString("url","")?:""
  if(url.isBlank()){Toast.makeText(this,"Сначала подключи канал «телефон ↔ я».",Toast.LENGTH_LONG).show();return}
  Thread{
   val bridge=LiveBridge(this){}
   bridge.configure(url,p.getString("token","")?:"");bridge.start();Thread.sleep(700)
   val ok=bridge.sendAttachment(uri)
   runOnUiThread{Toast.makeText(this,if(ok)"Материал отправлен Copilot" else "Не удалось отправить материал",Toast.LENGTH_SHORT).show()}
   bridge.stop()
  }.start()
 }
 private fun handleIncomingIntent(i:Intent?){
  if(i?.action==Intent.ACTION_SEND)i.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let(::attach)
  else if(i?.action==Intent.ACTION_SEND_MULTIPLE)i.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.forEach(::attach)
 }
 private fun refresh(){
  val b=CopilotState.balance(this);val v=CopilotState.snapshot(this);val g=CopilotState.garage(this);val d=CopilotState.decision(this);val ls=LearningMemory.stats(this)
  status.text="Решение: "+d+"\nОбучение: "+ls.samples+" сделок • "+ls.accuracy+"% положительных\nБаланс: "+fmt(b)+" ₽\nГараж: "+g+"/3\nМониторинг: "+if(CopilotState.monitoring(this))"ВКЛ" else "ВЫКЛ"
  vehicle.text=if(v.name.isEmpty())"Последняя машина: пока нет распознавания" else "Последняя машина:\n"+v.name+"\nЦена: "+(v.price?.let{fmt(it)+" ₽"}?:"—")+" • "+(v.hp?.let{it.toString()+" л.с."}?:"—")+"\nПроисхождение: "+v.origin.ifEmpty{"—"}+" • Крашеных: "+(v.paintedParts?.toString()?:"—")+"\nПробег: "+(v.mileage?.let{fmt(it)+" км"}?:"—")+" • Владельцев: "+(v.owners?:"—")+"\nНомер: "+v.plate.ifEmpty{"—"}
  val deals=CopilotState.deals(this).take(8).joinToString("\n"){x->val result=if(x.buy!=null&&x.sell!=null)"результат "+fmt(x.sell-x.buy-x.fees)+" ₽" else "открыта";"• "+x.name.ifEmpty{"Авто"}+" "+x.plate+" • "+(x.buy?.let{"куплено "+fmt(it)+" ₽"}?:"")+" "+(x.sell?.let{"продано "+fmt(it)+" ₽"}?:"")+" • расходы "+fmt(x.fees)+" ₽ • "+result}
  val ledger=CopilotState.ledger(this).take(10).joinToString("\n"){e->"• "+e.type+": "+fmt(e.amount?:0)+" ₽ "+e.note}
  val plates=CopilotState.plates(this).take(10).joinToString("\n"){x->"• "+x.plate+" — "+x.state+(x.value?.let{" • "+fmt(it)+" ₽"}?:"")}
  tabs.text="РАЗДЕЛЫ\nОбзор • Сделки • Расходы • Номера • События\n\nСделки:\n"+(if(deals.isEmpty())"пока нет" else deals)+"\n\nНомера:\n"+(if(plates.isEmpty())"пока нет" else plates)+"\n\nПоследние расходы/операции:\n"+(if(ledger.isEmpty())"пока нет" else ledger)
  val offers=CopilotState.buyerOffers(this,v.plate).take(5)
  val auctionText=if(v.plate.isBlank()) "🔖 Номера / аукцион: номер не распознан" else {
   val a=CopilotState.plateAuction(this,v.plate)
   val best=CopilotState.plateBestBid(this,v.plate)
   val bids=CopilotState.plateBids(this,v.plate)
   val roi=CopilotState.plateRoi(this,v.plate)
   val margin=CopilotState.plateAuctionMarginPercent(this,v.plate)
   val cost=CopilotState.plateCost(this,v.plate)
   val net=CopilotState.plateNetResult(this,v.plate)
   "🔖 НОМЕР / АУКЦИОН\nНомер: "+v.plate+"\nСтатус: "+a.optString("status","нет данных")+
    (if(a.has("starting_price"))"\nСтарт: "+fmt(a.optLong("starting_price"))+" ₽" else "")+
    (if(best!=null)"\nЛучшая ставка: "+fmt(best)+" ₽ • ставок: "+bids.size else "\nСтавок: 0")+
    (if(a.has("final_price"))"\nФинальная цена: "+fmt(a.optLong("final_price"))+" ₽" else "")+
    (if(cost!=null)"\nСебестоимость номера: "+fmt(cost)+" ₽" else "\nСебестоимость номера: нет данных")+
    (if(net!=null)"\nЧистый результат: "+fmt(net)+" ₽" else "\nЧистый результат: нет данных")+
    (if(roi!=null)"\nROI номера: "+String.format("%.1f",roi)+"%" else "\nROI номера: нет данных")+
    (if(margin!=null)"\nМаржа от старта: "+String.format("%.1f",margin)+"%" else "")+
    "\nКомиссии: "+fmt(a.optLong("fees",0))+" ₽"+
    "\nПравило: на аукционе продаются только номера; машина не выставляется."
  }
  val actionSummary=if(v.name.isEmpty()) emptyList() else ActionRoiEngine.summary(this,v)
  val forecast=CopilotState.forecast(this)
  val forecastText=try{val fo=org.json.JSONObject(forecast);"• Продажа: "+(if(fo.has("sale_price"))fmt(fo.optLong("sale_price"))+" ₽" else "—")+" • Прибыль: "+(if(fo.has("expected_profit"))fmt(fo.optLong("expected_profit"))+" ₽" else "—")+" • ROI: "+(if(fo.has("roi_percent"))String.format("%.1f",fo.optDouble("roi_percent"))+"%" else "—")}catch(_:Exception){"—"}
  attachments.text="📎 Вложения: фото/скриншоты • видео • документы/файлы\\nМожно выбрать материал здесь или отправить его в CarFlipCopilot через «Поделиться».\\n\\n"+auctionText+"\\n\\n💰 Предложения покупателей:\\n"+(if(offers.isEmpty())"пока нет" else offers.joinToString("\\n"))+"\\n\\n📊 Прогноз сделки:\\n"+forecastText+"\\n\\n🔧 ROI действий:\\n"+(if(actionSummary.isEmpty())"пока нет реальных данных" else actionSummary.joinToString("\\n"))
 }
 private fun showBridgeDialog(){
  val p=getSharedPreferences("live_bridge",0);val box=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(20,0,20,0)}
  val url=EditText(this).apply{hint="wss://адрес-моста/ws";setText(p.getString("url","")?:"")}
  val token=EditText(this).apply{hint="Секретный ключ";setText(p.getString("token","")?:"")}
  box.addView(url);box.addView(token)
  AlertDialog.Builder(this).setTitle("Постоянный канал «телефон ↔ я»").setMessage("Copilot получает состояние игры, кадры экрана и выбранные фото, скриншоты, видео и файлы.").setView(box).setNegativeButton("Отмена",null).setPositiveButton("Сохранить"){_,_->LiveBridge(this){}.configure(url.text.toString(),token.text.toString());Toast.makeText(this,"Канал сохранён. Запусти мониторинг.",Toast.LENGTH_SHORT).show()}.show()
 }
 private fun requestCapture(){if(!Settings.canDrawOverlays(this)){startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:"+packageName)));return};val mgr=getSystemService(MEDIA_PROJECTION_SERVICE)as MediaProjectionManager;startActivityForResult(mgr.createScreenCaptureIntent(),captureCode)}
 override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){super.onActivityResult(requestCode,resultCode,data);if(requestCode==captureCode&&resultCode==Activity.RESULT_OK&&data!=null)startForegroundService(Intent(this,ScreenMonitorService::class.java).putExtra("resultCode",resultCode).putExtra("data",data))}
}