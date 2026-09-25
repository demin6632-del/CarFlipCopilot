package com.carflip.copilot
import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.*
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private val captureCode = 1001
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = getSharedPreferences("copilot", MODE_PRIVATE)
        if (!store.contains("balance")) store.edit().putLong("balance", 8741902L).apply()
        val title = TextView(this).apply { text = "🚗 Перекуп Copilot"; textSize = 28f; setPadding(24,28,24,12) }
        val status = TextView(this).apply { textSize = 17f; setPadding(24,12,24,20) }
        fun refresh() {
            val b = store.getLong("balance",8741902L)
            status.text = "Баланс: ${"%,d".format(b).replace(',', ' ')} ₽\nГараж: 0/3\nКонтракт: Кинопродюсер\nUSA • ≥300 л.с. • ≤2 500 000 ₽"
        }
        val permissions = Button(this).apply {
            text = "Разрешить панель поверх Telegram"
            setOnClickListener { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) }
        }
        val start = Button(this).apply { text = "Запустить мониторинг Telegram"; setOnClickListener { requestCapture() } }
        val stop = Button(this).apply { text = "Остановить мониторинг"; setOnClickListener { stopService(Intent(this@MainActivity,ScreenMonitorService::class.java)) } }
        setContentView(LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; addView(title);addView(status);addView(permissions);addView(start);addView(stop) })
        refresh()
    }
    private fun requestCapture() {
        if (!Settings.canDrawOverlays(this)) { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))); return }
        val mgr=getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(mgr.createScreenCaptureIntent(),captureCode)
    }
    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?) {
        super.onActivityResult(requestCode,resultCode,data)
        if(requestCode==captureCode && resultCode==Activity.RESULT_OK && data!=null) {
            startForegroundService(Intent(this,ScreenMonitorService::class.java).putExtra("resultCode",resultCode).putExtra("data",data))
        }
    }
}
