package com.carflip.copilot

import android.app.*
import android.content.*
import android.graphics.*
import android.media.*
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.provider.Settings
import android.view.*
import android.widget.TextView
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

class ScreenMonitorService:Service(){
 private lateinit var commandServer:CommandServer
 private lateinit var remotePoller:RemoteCommandPoller
 private lateinit var liveBridge:LiveBridge
 private var lastFrame:Bitmap?=null
 private val stableOcr=StableOcr()
 private var projection:MediaProjection?=null;private var reader:ImageReader?=null;private var overlay:TextView?=null;private var lastCapture=0L;private var lastScreenKey="";private var lastBalance:Long?=null;private var lastBalanceAt=0L
 private val recognizer by lazy{TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)}
 override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int{
  CopilotState.setMonitoring(this,true);createChannel()
  commandServer=CommandServer(this);commandServer.start()
  remotePoller=RemoteCommandPoller(this);remotePoller.start()
  liveBridge=LiveBridge(this){cmd->when{
   cmd.uppercase()== "REQUEST_FRAME" -> lastFrame?.let{liveBridge.sendFrame(it)}
   cmd.uppercase()== "STATUS" -> sendLiveStatus()
   cmd.uppercase()== "STOP" -> stopSelf()
   cmd.startsWith("ATTACHMENT_ANALYSIS|") -> { val p=cmd.split("|",limit=3); if(p.size>=3) CopilotState.addEvent(this,"ВЛОЖЕНИЕ • "+p[1]+"\\n"+p[2]) }
   cmd.startsWith("ATTACHMENT_ANALYSIS_ERROR|") -> CopilotState.addEvent(this,"ОШИБКА АНАЛИЗА ВЛОЖЕНИЯ • "+cmd.substringAfter("|"))
  }}
  liveBridge.start()
  startForeground(10,Notification.Builder(this,"copilot").setContentTitle("Перекуп Copilot").setContentText("Мониторинг экрана • Telegram не нажимаю").setSmallIcon(android.R.drawable.ic_menu_view).build())
  val code=intent?.getIntExtra("resultCode",-1)?:-1
  val data=if(Build.VERSION.SDK_INT>=33)intent?.getParcelableExtra("data",Intent::class.java) else @Suppress("DEPRECATION") intent?.getParcelableExtra("data")
  if(code!=-1&&data!=null){projection=(getSystemService(MEDIA_PROJECTION_SERVICE)as MediaProjectionManager).getMediaProjection(code,data);capture()}
  showOverlay();return START_NOT_STICKY
 }
 private fun capture(){
  if(reader!=null)return
  val dm=resources.displayMetrics;val w=dm.widthPixels;val h=dm.heightPixels
  reader=ImageReader.newInstance(w,h,PixelFormat.RGBA_8888,2)
  projection?.createVirtualDisplay("CarFlipCopilot",w,h,dm.densityDpi,0,reader!!.surface,null,Handler(Looper.getMainLooper()))
  reader?.setOnImageAvailableListener({r->
   val now=System.currentTimeMillis();if(now-lastCapture<600){r.acquireLatestImage()?.close();return@setOnImageAvailableListener}
   val im=r.acquireLatestImage()?:return@setOnImageAvailableListener;lastCapture=now;ocr(im)
  },Handler(Looper.getMainLooper()))
 }
 private fun ocr(im:Image){
  val plane=im.planes[0]
  val pixelStride=plane.pixelStride
  val rowStride=plane.rowStride
  val rowPadding=rowStride-pixelStride*im.width
  val paddedWidth=im.width+rowPadding/pixelStride
  val bitmap=Bitmap.createBitmap(paddedWidth,im.height,Bitmap.Config.ARGB_8888)
  bitmap.copyPixelsFromBuffer(plane.buffer)
  im.close()
  val cropped=if(paddedWidth!=im.width)Bitmap.createBitmap(bitmap,0,0,im.width,im.height)else bitmap
  if(cropped!==bitmap)bitmap.recycle()
  recognizer.process(InputImage.fromBitmap(cropped,0)).addOnSuccessListener{res->
   val rawText=res.text.trim();if(rawText.isEmpty())return@addOnSuccessListener
   val text=stableOcr.accept(rawText) ?: return@addOnSuccessListener
   val v=VehicleSnapshot(GameParser.name(text),GameParser.price(text),GameParser.hp(text),GameParser.mileage(text),GameParser.owners(text),GameParser.plate(text),GameParser.origin(text),GameParser.paintedParts(text),text)
   val event=GameParser.event(text);val purchase=GameParser.purchaseAmount(text);val sale=GameParser.saleAmount(text);val expense=GameParser.expenseAmount(text)
   val bal=GameParser.balance(text);val garage=GameParser.garage(text)
   if(bal!=null){
    if(lastBalance!=null&&bal!=lastBalance&&System.currentTimeMillis()-lastBalanceAt>2500){
     val delta=bal-lastBalance!!
     if(purchase!=null)CopilotState.recordPurchase(this,v,purchase)
     else if(sale!=null)CopilotState.recordSale(this,v,sale)
     else if(expense!=null)CopilotState.addFee(this,expense,"Распознано на экране")
     else CopilotState.addLedger(this,"ИЗМЕНЕНИЕ БАЛАНСА",delta,"Безопасно: тип операции не определён")
     CopilotState.addEvent(this,"БАЛАНС • "+(if(delta>=0)"+" else "")+delta+" ₽ → "+bal+" ₽")
    }
    CopilotState.setBalance(this,bal);lastBalance=bal;lastBalanceAt=System.currentTimeMillis()
   }
   if(garage!=null)CopilotState.setGarage(this,garage)
   if(v.plate.isNotEmpty()){
    val s=text.lowercase()
    when{
     s.contains("снять номер")||s.contains("снятие номера")||s.contains("снял номер")->CopilotState.setPlate(this,v.plate,"СНЯТ")
     s.contains("хранилищ")||s.contains("хранении")->CopilotState.setPlate(this,v.plate,"ХРАНЕНИЕ")
     s.contains("аукцион")->CopilotState.setPlate(this,v.plate,"АУКЦИОН",sale)
     s.contains("продан")&&s.contains("номер")->CopilotState.setPlate(this,v.plate,"ПРОДАН",sale)
    }
   }
   val key=listOf(text.hashCode(),bal,garage,event,purchase,sale,expense,v.name,v.price,v.hp,v.mileage,v.owners,v.plate,v.origin,v.paintedParts).joinToString("|")
   if(key!=lastScreenKey){
    lastScreenKey=key;CopilotState.setSnapshot(this,v)
    when(event){
     "ПОКУПКА"->purchase?.let{CopilotState.addEvent(this,"ПОКУПКА • "+it+" ₽ • "+v.name);if(bal==null)CopilotState.recordPurchase(this,v,it)}
     "ПРОДАЖА"->sale?.let{CopilotState.addEvent(this,"ПРОДАЖА • "+it+" ₽ • "+v.name);if(bal==null)CopilotState.recordSale(this,v,it)}
     "РАСХОД"->expense?.let{CopilotState.addEvent(this,"РАСХОД • "+it+" ₽ • "+v.name);if(bal==null)CopilotState.addFee(this,it,"Распознано на экране")}
     "АУКЦИОН"->CopilotState.addEvent(this,"АУКЦИОН • "+v.plate.ifEmpty{"без номера"}+(sale?.let{" • "+it+" ₽"}?:""))
    }
    GameParser.contract(text)?.let{CopilotState.addEvent(this,"КОНТРАК • "+it)}
   }
   val decision=GameParser.decision(v);CopilotState.setDecision(this,decision)
   val opportunity=OpportunityAnalyzer.analyze(this,text,v,bal?:CopilotState.balance(this),garage?:CopilotState.garage(this))
   CopilotState.setDecision(this,opportunity.action)
   liveBridge.sendState(text,v,CopilotState.balance(this),CopilotState.garage(this),opportunity.action,opportunity)
   val oldFrame=lastFrame; lastFrame=null
   val maxW=720; val scaled=if(cropped.width>maxW)Bitmap.createScaledBitmap(cropped,maxW,(cropped.height*maxW/cropped.width),true) else cropped.copy(Bitmap.Config.ARGB_8888,false); if(oldFrame!=null&&oldFrame!==cropped)oldFrame.recycle(); lastFrame=scaled
   val out=StringBuilder("🚗 COPILOT • LIVE\\n").append(opportunity.action).append("  •  ").append(opportunity.confidence).append("%\\n").append(opportunity.title).append("\\n").append(opportunity.reason)
   if(v.name.isNotEmpty())out.append("\n").append(v.name)
   if(v.price!=null)out.append("\nЦена: ").append("%,d".format(v.price).replace(',',' ')).append(" ₽")
   if(v.hp!=null)out.append("\nМощность: ").append(v.hp).append(" л.с.")
   if(v.origin.isNotEmpty())out.append("\nПроисхождение: ").append(v.origin)
   if(v.paintedParts!=null)out.append("\nКрашеных деталей: ").append(v.paintedParts)
   if(v.mileage!=null)out.append("\nПробег: ").append("%,d".format(v.mileage).replace(',',' ')).append(" км")
   if(v.owners!=null)out.append("\nВладельцев: ").append(v.owners)
   if(v.plate.isNotEmpty())out.append("\nНомер: ").append(v.plate)
   out.append("\n\nБаланс: ").append("%,d".format(CopilotState.balance(this)).replace(',',' ')).append(" ₽")
   out.append("\nГараж: ").append(CopilotState.garage(this)).append("/3")
   out.append("\n\nМониторинг: ВКЛ • обновление ~0,6 с")
   Handler(Looper.getMainLooper()).post{overlay?.text=out.toString()}
  }.addOnCompleteListener{cropped.recycle()}
 }
 private fun showOverlay(){
  if(!Settings.canDrawOverlays(this)||overlay!=null)return
  val wm=getSystemService(WINDOW_SERVICE)as WindowManager
  overlay=TextView(this).apply{text="COPILOT\nСмотрю экран…";textSize=16f;setPadding(22,16,22,16);setTextColor(Color.WHITE);setBackgroundColor(0xEE111111.toInt())}
  val p=WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,PixelFormat.TRANSLUCENT)
  p.gravity=Gravity.TOP or Gravity.START;p.x=16;p.y=90;wm.addView(overlay,p)
 }
 private fun createChannel(){(getSystemService(NOTIFICATION_SERVICE)as NotificationManager).createNotificationChannel(NotificationChannel("copilot","Перекуп Copilot",NotificationManager.IMPORTANCE_LOW))}
 private fun sendLiveStatus(){val v=CopilotState.snapshot(this);val o=OpportunityAnalyzer.analyze(this,v.raw,v,CopilotState.balance(this),CopilotState.garage(this));liveBridge.sendState(v.raw,v,CopilotState.balance(this),CopilotState.garage(this),o.action,o)}
 override fun onDestroy(){CopilotState.setMonitoring(this,false);if(::commandServer.isInitialized)commandServer.stop();if(::remotePoller.isInitialized)remotePoller.stop();if(::liveBridge.isInitialized)liveBridge.stop();lastFrame?.recycle();reader?.close();projection?.stop();overlay?.let{(getSystemService(WINDOW_SERVICE)as WindowManager).removeView(it)};recognizer.close();super.onDestroy()}
 override fun onBind(intent:Intent?):IBinder?=null
}