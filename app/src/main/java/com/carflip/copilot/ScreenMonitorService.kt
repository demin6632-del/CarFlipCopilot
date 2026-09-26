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
  CopilotState.setMonitoring(this,true);createChannel();commandServer=CommandServer(this);commandServer.start();remotePoller=RemoteCommandPoller(this);remotePoller.start()
  liveBridge=LiveBridge(this){cmd->when(cmd.uppercase()){"REQUEST_FRAME"->lastFrame?.let{liveBridge.sendFrame(it)};"STATUS"->sendLiveStatus();"STOP"->stopSelf()}};liveBridge.start()
  startForeground(10,Notification.Builder(this,"copilot").setContentTitle("Перекуп Copilot").setContentText("Мониторинг экрана • Telegram не нажимаю").setSmallIcon(android.R.drawable.ic_menu_view).build())
  val code=intent?.getIntExtra("resultCode",-1)?:-1;val data=if(Build.VERSION.SDK_INT>=33)intent?.getParcelableExtra("data",Intent::class.java) else @Suppress("DEPRECATION") intent?.getParcelableExtra("data")
  if(code!=-1&&data!=null){projection=(getSystemService(MEDIA_PROJECTION_SERVICE)as MediaProjectionManager).getMediaProjection(code,data);capture()};showOverlay();return START_NOT_STICKY
 }
 private fun capture(){if(reader!=null)return;val dm=resources.displayMetrics;val w=dm.widthPixels;val h=dm.heightPixels;reader=ImageReader.newInstance(w,h,PixelFormat.RGBA_8888,2);projection?.createVirtualDisplay("CarFlipCopilot",w,h,dm.densityDpi,0,reader!!.surface,null,Handler(Looper.getMainLooper()));reader?.setOnImageAvailableListener({r->val now=System.currentTimeMillis();if(now-lastCapture<600){r.acquireLatestImage()?.close();return@setOnImageAvailableListener};val im=r.acquireLatestImage()?:return@setOnImageAvailableListener;lastCapture=now;ocr(im)},Handler(Looper.getMainLooper()))}
 private fun ocr(im:Image){val plane=im.planes[0];val pixelStride=plane.pixelStride;val rowStride=plane.rowStride;val rowPadding=rowStride-pixelStride*im.width;val paddedWidth=im.width+rowPadding/pixelStride;val bitmap=Bitmap.createBitmap(paddedWidth,im.height,Bitmap.Config.ARGB_8888);bitmap.copyPixelsFromBuffer(plane.buffer);im.close();val cropped=if(paddedWidth!=im.width)Bitmap.createBitmap(bitmap,0,0,im.width,im.height)else bitmap;if(cropped!==bitmap)bitmap.recycle()
  recognizer.process(InputImage.fromBitmap(cropped,0)).addOnSuccessListener{res->val rawText=res.text.trim();if(rawText.isEmpty())return@addOnSuccessListener;val text=stableOcr.accept(rawText)?:return@addOnSuccessListener
   val prev=CopilotState.snapshot(this);val v0=VehicleSnapshot(name=GameParser.name(text),price=GameParser.price(text),hp=GameParser.hp(text),mileage=GameParser.mileage(text),owners=GameParser.owners(text),plate=GameParser.plate(text),origin=GameParser.origin(text),paintedParts=GameParser.paintedParts(text),stage=GameParser.stage(text),invested=GameParser.invested(text),polishApplied=GameParser.polishApplied(text),raw=text);val v=VehicleSnapshot(name=if(v0.name.isNotBlank())v0.name else prev.name,price=v0.price?:prev.price,hp=v0.hp?:prev.hp,mileage=v0.mileage?:prev.mileage,owners=v0.owners?:prev.owners,plate=if(v0.plate.isNotBlank())v0.plate else prev.plate,origin=if(v0.origin.isNotBlank())v0.origin else prev.origin,paintedParts=v0.paintedParts?:prev.paintedParts,stage=v0.stage?:prev.stage,invested=v0.invested?:prev.invested,polishApplied=v0.polishApplied?:prev.polishApplied,raw=text)
   val event=GameParser.event(text);val purchase=GameParser.purchaseAmount(text);val sale=GameParser.saleAmount(text);val expense=GameParser.expenseAmount(text);val bal=GameParser.balance(text);val garage=GameParser.garage(text)
   if(bal!=null){if(lastBalance!=null&&bal!=lastBalance&&System.currentTimeMillis()-lastBalanceAt>2500){val delta=bal-lastBalance!!;if(purchase!=null)CopilotState.recordPurchase(this,v,purchase)else if(sale!=null)CopilotState.recordSale(this,v,sale)else if(expense!=null)CopilotState.addFee(this,expense,"Распознано на экране")else CopilotState.addLedger(this,"ИЗМЕНЕНИЕ БАЛАНСА",delta,"Безопасно: тип операции не определён");CopilotState.addEvent(this,"БАЛАНС • "+(if(delta>=0)"+" else "")+delta+" ₽ → "+bal+" ₽")};CopilotState.setBalance(this,bal);lastBalance=bal;lastBalanceAt=System.currentTimeMillis()};if(garage!=null)CopilotState.setGarage(this,garage)
   if(v.plate.isNotEmpty()){val s=text.lowercase();when{ s.contains("снять номер")||s.contains("снятие номера")||s.contains("снял номер")->CopilotState.setPlate(this,v.plate,"СНЯТ");s.contains("хранилищ")||s.contains("хранении")->CopilotState.setPlate(this,v.plate,"ХРАНЕНИЕ");s.contains("аукцион")->CopilotState.setPlate(this,v.plate,"АУКЦИОН",sale);s.contains("продан")&&s.contains("номер")->CopilotState.setPlate(this,v.plate,"ПРОДАН",sale)}}
   val key=listOf(text.hashCode(),bal,garage,event,purchase,sale,expense,v.name,v.price,v.hp,v.mileage,v.owners,v.plate,v.origin,v.paintedParts,v.stage,v.invested,v.polishApplied).joinToString("|");if(key!=lastScreenKey){lastScreenKey=key;CopilotState.setSnapshot(this,v);when(event){"ПОКУПКА"->purchase?.let{CopilotState.addEvent(this,"ПОКУПКА • "+it+" ₽ • "+v.name);if(bal==null)CopilotState.recordPurchase(this,v,it)};"ПРОДАЖА"->sale?.let{CopilotState.addEvent(this,"ПРОДАЖА • "+it+" ₽ • "+v.name);if(bal==null)CopilotState.recordSale(this,v,it)};"РАСХОД"->expense?.let{CopilotState.addEvent(this,"РАСХОД • "+it+" ₽ • "+v.name);if(bal==null)CopilotState.addFee(this,it,"Распознано на экране")};"АУКЦИОН"->CopilotState.addEvent(this,"АУКЦИОН • "+v.plate.ifEmpty{"без номера"}+(sale?.let{" • "+it+" ₽"}?:""))};GameParser.contract(text)?.let{CopilotState.addEvent(this,"КОНТРАК • "+it)}}
   val opportunity=OpportunityAnalyzer.analyze(this,text,v,bal?:CopilotState.balance(this),garage?:CopilotState.garage(this));CopilotState.setDecision(this,opportunity.action);SituationEngine.observe(this,text,v,CopilotState.balance(this),CopilotState.garage(this));val observedExit=GameParser.exitPrice(text);if(observedExit!=null && sale==null)LearningMemory.recordOffer(this,v,observedExit);val learnedExit=if(observedExit==null)LearningMemory.estimateSalePrice(this,v)else SalePriceEstimate(observedExit,0,100);val economics=TradeEconomics.calculate(v,learnedExit.price);liveBridge.sendState(text,v,CopilotState.balance(this),CopilotState.garage(this),opportunity.action,opportunity)
   val oldFrame=lastFrame;lastFrame=null;val maxW=720;val scaled=if(cropped.width>maxW)Bitmap.createScaledBitmap(cropped,maxW,cropped.height*maxW/cropped.width,true)else cropped.copy(Bitmap.Config.ARGB_8888,false);if(oldFrame!=null&&oldFrame!==cropped)oldFrame.recycle();lastFrame=scaled
   val out=StringBuilder("🚗 COPILOT • LIVE\n").append(opportunity.action).append(" • ").append(opportunity.confidence).append("%\n").append(opportunity.title).append("\n").append(opportunity.reason)
   opportunity.forecast?.let{f->
    out.append("\n\nПОСЛЕ ДЕЙСТВИЯ:")
    f.balanceAfter?.let{out.append("\nБаланс: ").append(fmt(it)).append(" ₽")}
    f.garageAfter?.let{out.append("\nГараж: ").append(it).append("/3")}
    f.expectedProfit?.let{out.append("\nОжидаемый результат: ").append(if(it>=0) "+" else "").append(fmt(it)).append(" ₽")}
    out.append("\nРиск: ").append(f.risk)
    f.blocked?.let{out.append("\nОграничение: ").append(it)}
    out.append("\nСледующий шаг: ").append(f.nextStep)
   }
   if(opportunity.alternatives.isNotEmpty())out.append("\n\nАЛЬТЕРНАТИВЫ:\n").append(opportunity.alternatives.joinToString("\n"){"• "+it})
   if(v.name.isNotEmpty())out.append("\n\n").append(v.name)
   if(v.price!=null)out.append("\nЦена входа: ").append(fmt(v.price)).append(" ₽")
   out.append("\nПроверки: ").append(fmt(economics.inspectionCosts)).append(" ₽")
   if(v.price!=null)out.append("\nСебестоимость: ").append(fmt(economics.totalKnownCosts)).append(" ₽")
   out.append("\nКонтракт: ").append(if(economics.contractEligible)"ПОДХОДИТ" else "НЕ ПОДТВЕРЖДЁН")
   if(economics.contractMissing.isNotEmpty())out.append("\nНе хватает: ").append(economics.contractMissing.joinToString(", "))
   if(economics.contractEligible)out.append("\nБонус: +").append(fmt(economics.contractBonus)).append(" ₽")
   out.append("\nЦена продажи: ").append(learnedExit.price?.let{fmt(it)}?:"—").append(" ₽")
   if(learnedExit.price!=null)out.append(if(observedExit!=null)" • предложение покупателя" else " • оценка по истории ("+learnedExit.samples+" сделок, "+learnedExit.confidence+"% доверие)")
   if(observedExit!=null){LearningMemory.actionRoi(this,v,observedExit).forEach{r->out.append("\nROI ").append(r.action).append(": Δ цены ").append(if(r.priceDelta>=0)"+" else "").append(fmt(r.priceDelta)).append(" ₽, затраты ").append(fmt(r.cost)).append(" ₽ → ").append(if(r.roi>=0)"+" else "").append(fmt(r.roi)).append(" ₽")}}
   out.append("\nОжидаемая прибыль: ").append(economics.expectedProfit?.let{(if(it>=0) "+" else "")+fmt(it)}?:"—").append(" ₽")
   if(v.hp!=null)out.append("\nМощность: ").append(v.hp).append(" л.с.")
   if(v.stage!=null)out.append("\nStage: ").append(v.stage)
   if(v.invested!=null)out.append("\nВложено в проект: ").append(fmt(v.invested)).append(" ₽")
   if(v.polishApplied!=null)out.append("\nПолировка: ").append(if(v.polishApplied) "Да" else "Нет")
   if(v.origin.isNotEmpty())out.append("\nПроисхождение: ").append(v.origin)
   if(v.paintedParts!=null)out.append("\nКрашеных деталей: ").append(v.paintedParts)
   if(v.mileage!=null)out.append("\nПробег: ").append(fmt(v.mileage)).append(" км")
   if(v.owners!=null)out.append("\nВладельцев: ").append(v.owners)
   if(v.plate.isNotEmpty())out.append("\nНомер: ").append(v.plate)
   out.append("\n\nБаланс: ").append(fmt(CopilotState.balance(this))).append(" ₽").append("\nГараж: ").append(CopilotState.garage(this)).append("/3").append("\n\nМониторинг: ВКЛ • ~0,6 с")
   Handler(Looper.getMainLooper()).post{overlay?.text=out.toString()}
  }.addOnCompleteListener{cropped.recycle()}}
 private fun fmt(v:Long)="%,d".format(v).replace(',',' ')
 private fun showOverlay(){if(!Settings.canDrawOverlays(this)||overlay!=null)return;val wm=getSystemService(WINDOW_SERVICE)as WindowManager;overlay=TextView(this).apply{text="COPILOT\nСмотрю экран…";textSize=16f;setPadding(22,16,22,16);setTextColor(Color.WHITE);setBackgroundColor(0xEE111111.toInt())};val p=WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,PixelFormat.TRANSLUCENT);p.gravity=Gravity.TOP or Gravity.START;p.x=16;p.y=90;wm.addView(overlay,p)}
 private fun createChannel(){(getSystemService(NOTIFICATION_SERVICE)as NotificationManager).createNotificationChannel(NotificationChannel("copilot","Перекуп Copilot",NotificationManager.IMPORTANCE_LOW))}
 private fun sendLiveStatus(){val v=CopilotState.snapshot(this);val o=OpportunityAnalyzer.analyze(this,v.raw,v,CopilotState.balance(this),CopilotState.garage(this));liveBridge.sendState(v.raw,v,CopilotState.balance(this),CopilotState.garage(this),o.action,o)}
 override fun onDestroy(){CopilotState.setMonitoring(this,false);if(::commandServer.isInitialized)commandServer.stop();if(::remotePoller.isInitialized)remotePoller.stop();if(::liveBridge.isInitialized)liveBridge.stop();lastFrame?.recycle();reader?.close();projection?.stop();overlay?.let{(getSystemService(WINDOW_SERVICE)as WindowManager).removeView(it)};recognizer.close();super.onDestroy()}
 override fun onBind(intent:Intent?):IBinder?=null
}