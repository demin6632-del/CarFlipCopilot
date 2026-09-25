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

class ScreenMonitorService: Service() {
    private var projection:MediaProjection?=null
    private var reader:ImageReader?=null
    private var overlay:TextView?=null
    private var last=0L
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int {
        createChannel()
        startForeground(10,Notification.Builder(this,"copilot").setContentTitle("Перекуп Copilot").setContentText("Мониторинг экрана активен").setSmallIcon(android.R.drawable.ic_menu_view).build())
        val code=intent?.getIntExtra("resultCode",-1) ?: -1
        val data=if(Build.VERSION.SDK_INT>=33) intent?.getParcelableExtra("data",Intent::class.java) else @Suppress("DEPRECATION") intent?.getParcelableExtra("data")
        if(code!=-1 && data!=null) {
            projection=(getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager).getMediaProjection(code,data)
            capture()
        }
        showOverlay()
        return START_NOT_STICKY
    }

    private fun capture() {
        val dm=resources.displayMetrics; val w=dm.widthPixels; val h=dm.heightPixels
        reader=ImageReader.newInstance(w,h,PixelFormat.RGBA_8888,2)
        projection?.createVirtualDisplay("CarFlipCopilot",w,h,dm.densityDpi,0,reader!!.surface,null,Handler(Looper.getMainLooper()))
        reader?.setOnImageAvailableListener({ r ->
            val now=System.currentTimeMillis()
            if(now-last<1800){r.acquireLatestImage()?.close();return@setOnImageAvailableListener}
            val im=r.acquireLatestImage() ?: return@setOnImageAvailableListener; last=now
            ocr(im)
        },Handler(Looper.getMainLooper()))
    }

    private fun ocr(im:Image) {
        val plane=im.planes[0]; val bitmap=Bitmap.createBitmap(im.width,im.height,Bitmap.Config.ARGB_8888)
        val buf=plane.buffer; bitmap.copyPixelsFromBuffer(buf); im.close()
        recognizer.process(InputImage.fromBitmap(bitmap,0)).addOnSuccessListener { result ->
            val text=result.text
            val price=Regex("""(?<!\d)(\d{1,3}(?:[ \u00A0]\d{3}){1,2}|\d{6,7})\s*₽?""").find(text)?.groupValues?.get(1)?.replace(" ","")?.replace("\u00A0","")?.toLongOrNull()
            val hp=Regex("""(\d{2,4})\s*(?:л\.\s*с\.?|лс|hp)""",RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1)?.toIntOrNull()
            val decision=when { price!=null && price>2500000L -> "НЕ ПОКУПАЙ"; hp!=null && hp<300 -> "НЕ ПОКУПАЙ"; price!=null -> "ПРОВЕРЯЙ"; else -> "СМОТРЮ…" }
            val out=buildString { append("COPILOT\n$decision"); if(price!=null) append("\nЦена: ${"%,d".format(price).replace(',', ' ')} ₽"); if(hp!=null) append("\nМощность: $hp л.с."); append("\n\nНажатия остаются за тобой.") }
            Handler(Looper.getMainLooper()).post { overlay?.text=out }
        }.addOnCompleteListener { bitmap.recycle() }
    }

    private fun showOverlay() {
        if(!Settings.canDrawOverlays(this)) return
        val wm=getSystemService(WINDOW_SERVICE) as WindowManager
        overlay=TextView(this).apply { text="COPILOT\nСмотрю экран…";textSize=16f;setPadding(22,16,22,16);setTextColor(Color.WHITE);setBackgroundColor(0xEE111111.toInt()) }
        val p=WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,PixelFormat.TRANSLUCENT)
        p.gravity=Gravity.TOP or Gravity.START;p.x=16;p.y=90;wm.addView(overlay,p)
    }
    private fun createChannel(){(getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(NotificationChannel("copilot","Перекуп Copilot",NotificationManager.IMPORTANCE_LOW))}
    override fun onDestroy(){reader?.close();projection?.stop();overlay?.let{(getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it)};recognizer.close();super.onDestroy()}
    override fun onBind(intent:Intent?):IBinder?=null
}
