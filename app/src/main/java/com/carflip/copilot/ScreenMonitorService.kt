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
    private var projection:MediaProjection?=null
    private var reader:ImageReader?=null
    private var overlay:TextView?=null
    private var lastCapture=0L
    private var lastScreenKey=""
    private var lastBalance:Long?=null
    private var lastBalanceAt=0L
    private val recognizer by lazy{TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)}

    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int{
        createChannel()
        startForeground(10,Notification.Builder(this,"copilot").setContentTitle("Перекуп Copilot").setContentText("Мониторинг экрана в реальном времени").setSmallIcon(android.R.drawable.ic_menu_view).build())
        val code=intent?.getIntExtra("resultCode",-1)?:-1
        val data=if(Build.VERSION.SDK_INT>=33)intent?.getParcelableExtra("data",Intent::class.java) else @Suppress("DEPRECATION") intent?.getParcelableExtra("data")
        if(code!=-1&&data!=null){
            projection=(getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager).getMediaProjection(code,data)
            capture()
        }
        showOverlay()
        return START_NOT_STICKY
    }
    private fun capture(){
        if(reader!=null)return
        val dm=resources.displayMetrics;val w=dm.widthPixels;val h=dm.heightPixels
        reader=ImageReader.newInstance(w,h,PixelFormat.RGBA_8888,2)
        projection?.createVirtualDisplay("CarFlipCopilot",w,h,dm.densityDpi,0,reader!!.surface,null,Handler(Looper.getMainLooper()))
        reader?.setOnImageAvailableListener({r->
            val now=System.currentTimeMillis()
            if(now-lastCapture<1000){r.acquireLatestImage()?.close();return@setOnImageAvailableListener}
            val im=r.acquireLatestImage()?:return@setOnImageAvailableListener
            lastCapture=now;ocr(im)
        },Handler(Looper.getMainLooper()))
    }
    private fun ocr(im:Image){
        val bitmap=Bitmap.createBitmap(im.width,im.height,Bitmap.Config.ARGB_8888)
        bitmap.copyPixelsFromBuffer(im.planes[0].buffer);im.close()
        recognizer.process(InputImage.fromBitmap(bitmap,0)).addOnSuccessListener{res->
            val text=res.text.trim();if(text.isEmpty())return@addOnSuccessListener
            val v=VehicleSnapshot(GameParser.name(text),GameParser.price(text),GameParser.hp(text),GameParser.mileage(text),GameParser.owners(text),GameParser.plate(text),text)
            val event=GameParser.event(text)
            val bal=GameParser.balance(text)
            val garage=GameParser.garage(text)
            if(bal!=null){
                val old=CopilotState.balance(this)
                if(lastBalance!=null && bal!=lastBalance && System.currentTimeMillis()-lastBalanceAt>2500){
                    val delta=bal-lastBalance!!
                    CopilotState.addLedger(this,"ИЗМЕНЕНИЕ БАЛАНСА",delta,"Баланс: "+bal+" ₽")
                    CopilotState.addEvent(this,"БАЛАНС • "+(if(delta>=0) "+" else "")+delta+" ₽ → "+bal+" ₽")
                }
                if(old!=bal)CopilotState.setBalance(this,bal)
                lastBalance=bal;lastBalanceAt=System.currentTimeMillis()
            }
            if(garage!=null)CopilotState.setGarage(this,garage)
            val key=listOf(text.hashCode(),bal,garage,event,v.name,v.price,v.hp,v.mileage,v.owners,v.plate).joinToString("|")
            if(key!=lastScreenKey){
                lastScreenKey=key
                CopilotState.setSnapshot(this,v)
                event?.let{
                    CopilotState.addEvent(this,it+" • "+text.lines().firstOrNull().orEmpty())
                    val amount=GameParser.transactionAmount(text)
                    if(amount!=null)CopilotState.addLedger(this,it,amount,if(v.name.isEmpty())"экран сделки" else v.name)
                }
                GameParser.contract(text)?.let{CopilotState.addEvent(this,"КОНТРАК • "+it)}
            }
            val decision=GameParser.decision(v)
            CopilotState.setDecision(this,decision)
            val out=StringBuilder("COPILOT\n").append(decision)
            if(v.name.isNotEmpty())out.append("\n").append(v.name)
            if(v.price!=null)out.append("\nЦена: ").append("%,d".format(v.price).replace(',',' ')).append(" ₽")
            if(v.hp!=null)out.append("\nМощность: ").append(v.hp).append(" л.с.")
            if(v.mileage!=null)out.append("\nПробег: ").append("%,d".format(v.mileage).replace(',',' ')).append(" км")
            if(v.owners!=null)out.append("\nВладельцев: ").append(v.owners)
            if(v.plate.isNotEmpty())out.append("\nНомер: ").append(v.plate)
            if(bal!=null)out.append("\nБаланс: ").append("%,d".format(bal).replace(',',' ')).append(" ₽")
            if(garage!=null)out.append("\nГараж: ").append(garage).append("/3")
            out.append("\n\nTelegram не нажимаю — решение за тобой.")
            Handler(Looper.getMainLooper()).post{overlay?.text=out.toString()}
        }.addOnCompleteListener{bitmap.recycle()}
    }
    private fun showOverlay(){
        if(!Settings.canDrawOverlays(this)||overlay!=null)return
        val wm=getSystemService(WINDOW_SERVICE) as WindowManager
        overlay=TextView(this).apply{text="COPILOT\nСмотрю экран…";textSize=16f;setPadding(22,16,22,16);setTextColor(Color.WHITE);setBackgroundColor(0xEE111111.toInt())}
        val p=WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,PixelFormat.TRANSLUCENT)
        p.gravity=Gravity.TOP or Gravity.START;p.x=16;p.y=90;wm.addView(overlay,p)
    }
    private fun createChannel(){(getSystemService(NOTIFICATION_SERVICE)as NotificationManager).createNotificationChannel(NotificationChannel("copilot","Перекуп Copilot",NotificationManager.IMPORTANCE_LOW))}
    override fun onDestroy(){reader?.close();projection?.stop();overlay?.let{(getSystemService(WINDOW_SERVICE)as WindowManager).removeView(it)};recognizer.close();super.onDestroy()}
    override fun onBind(intent:Intent?):IBinder?=null
}
