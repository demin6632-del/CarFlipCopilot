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

class MainActivity : AppCompatActivity() {
    private val captureCode = 1001
    private lateinit var status: TextView
    private lateinit var vehicle: TextView
    private lateinit var decision: TextView
    private lateinit var money: TextView
    private lateinit var deals: TextView
    private lateinit var plates: TextView
    private lateinit var events: TextView
    private lateinit var offers: TextView
    private lateinit var forecast: TextView
    private lateinit var actions: TextView
    private lateinit var attachments: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val refreshTask = object : Runnable { override fun run() { refresh(); handler.postDelayed(this, 1500) } }
    private val pickImage = registerForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(::attach) }
    private val pickVideo = registerForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(::attach) }
    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(::attach) }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 28) }
        fun text(size: Float = 15f) = TextView(this).apply { textSize = size; setPadding(0, 6, 0, 6) }
        fun card(title: String, body: TextView) = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(18, 14, 18, 14); background = android.graphics.drawable.GradientDrawable().apply { setColor(0xFFF5F5F5.toInt()); cornerRadius = 18f }; addView(text(18f).apply { this.text = title; setTypeface(null, android.graphics.Typeface.BOLD); setPadding(0,0,0,8) }); addView(body); root.addView(this, LinearLayout.LayoutParams(-1, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0,0,0,12) }) }
        root.addView(text(28f).apply { this.text = "🚗 CarFlipCopilot"; setTypeface(null, android.graphics.Typeface.BOLD) }); root.addView(text(14f).apply { this.text = "Спокойный режим • одно решение за раз" })
        status = text(); decision = text(19f); money = text(); vehicle = text(); deals = text(); plates = text(); events = text(); offers = text(); forecast = text(); actions = text(); attachments = text()
        card("Состояние Copilot", status); card("🎯 Что делать сейчас", decision); card("💰 Деньги и гараж", money); card("🚘 Текущая машина", vehicle); card("📊 Сделки", deals); card("🔖 Номера", plates); card("💬 Предложения покупателей", offers); card("📈 Прогноз сделки", forecast); card("🔧 Что дали улучшения", actions); card("🧠 Последние события", events); card("📎 Материалы", attachments)
        fun button(label: String, click: () -> Unit) = Button(this).apply { text = label; setOnClickListener { click() } }
        root.addView(button("▶ Запустить мониторинг") { requestCapture() }); root.addView(button("■ Остановить мониторинг") { stopMonitoring() }); root.addView(button("⚙ Разрешить панель поверх игры") { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + packageName))) }); root.addView(button("🔋 Разрешить работу без ограничений") { requestBatteryOptimizationExemption() }); root.addView(button("📷 Добавить скриншот") { pickImage.launch(arrayOf("image/*")) }); root.addView(button("🎥 Добавить видео") { pickVideo.launch(arrayOf("video/*")) }); root.addView(button("📎 Добавить файл") { pickFile.launch(arrayOf("*/*")) }); root.addView(button("🔗 Подключить канал «телефон ↔ Copilot»") { showBridgeDialog() })
        setContentView(ScrollView(this).apply { addView(root) }); handleIncomingIntent(intent)
    }
    override fun onResume() { super.onResume(); handler.post(refreshTask) }
    override fun onPause() { handler.removeCallbacks(refreshTask); super.onPause() }
    override fun onNewIntent(i: Intent) { super.onNewIntent(i); setIntent(i); handleIncomingIntent(i) }
    private fun fmt(v: Long) = "%,d".format(v).replace(',', ' ')
    private fun stopMonitoring() { stopService(Intent(this, ScreenMonitorService::class.java)); stopService(Intent(this, ScreenMonitorServiceV2::class.java)); CopilotState.setMonitoring(this, false) }
    private fun refresh() { val b = CopilotState.balance(this); val v = CopilotState.snapshot(this); val g = CopilotState.garage(this); val d = CopilotState.decision(this); val ls = LearningMemory.stats(this); status.text = "Мониторинг: ${if (CopilotState.monitoring(this)) "ВКЛЮЧЁН" else "ВЫКЛЮЧЕН"}\nОбучено: ${ls.samples} сделок • положительный результат ${ls.accuracy}%"; decision.text = d.ifBlank { "Наблюдаю игру…" }; money.text = "Баланс: ${fmt(b)} ₽\nГараж: $g / 3"; vehicle.text = if (v.name.isEmpty()) "Пока не распознана. Открой экран машины в игре." else "${v.name}\nЦена: ${v.price?.let { fmt(it) + " ₽" } ?: "—"}    Мощность: ${v.hp?.let { "$it л.с." } ?: "—"}\nПробег: ${v.mileage?.let { fmt(it) + " км" } ?: "—"}    Владельцев: ${v.owners ?: "—"}\nПроисхождение: ${v.origin.ifEmpty { "—" }}\nКрашеных деталей: ${v.paintedParts ?: "—"}\nНомер: ${v.plate.ifEmpty { "—" }}"; val ds = CopilotState.deals(this).take(6); deals.text = if (ds.isEmpty()) "Пока нет завершённых или открытых сделок." else ds.joinToString("\n\n") { x -> val r = if (x.buy != null && x.sell != null) "Результат: ${fmt(x.sell - x.buy - x.fees)} ₽" else "Сделка открыта"; "${x.name.ifEmpty { "Авто" }} ${x.plate}\nКуплено: ${x.buy?.let { fmt(it) + " ₽" } ?: "—"} • Продано: ${x.sell?.let { fmt(it) + " ₽" } ?: "—"}\nРасходы: ${fmt(x.fees)} ₽ • $r" }; val ps = CopilotState.plates(this).take(8); plates.text = if (ps.isEmpty()) "Номера пока не обнаружены." else ps.joinToString("\n") { "${it.plate} — ${it.state}${it.value?.let { v2 -> " • ${fmt(v2)} ₽" } ?: ""}" }; val os = CopilotState.buyerOffers(this, v.plate).take(5); offers.text = if (os.isEmpty()) "Пока нет предложений. Copilot будет запоминать реальные предложения покупателей." else os.joinToString("\n") { "• $it" }; forecast.text = try { val f = org.json.JSONObject(CopilotState.forecast(this)); "Ожидаемая продажа: ${if (f.has("sale_price")) fmt(f.optLong("sale_price")) + " ₽" else "—"}\nОжидаемая прибыль: ${if (f.has("expected_profit")) fmt(f.optLong("expected_profit")) + " ₽" else "—"}\nROI: ${if (f.has("roi_percent")) String.format("%.1f", f.optDouble("roi_percent")) + "%" else "—"}" } catch (_: Exception) { "Пока недостаточно данных для прогноза." }; val ar = if (v.name.isEmpty()) emptyList() else ActionRoiEngine.summary(this, v); actions.text = if (ar.isEmpty()) "Пока нет фактических результатов по улучшениям." else ar.joinToString("\n"); val ledger = CopilotState.ledger(this).take(8); events.text = if (ledger.isEmpty()) "Пока нет событий." else ledger.joinToString("\n") { "• ${it.type}: ${it.amount?.let { a -> fmt(a) + " ₽" } ?: ""} ${it.note}" }; attachments.text = "Скриншот / фото — анализ\nВидео — анализ кадров\nФайл — передача в Copilot\n\nМатериал можно выбрать здесь или отправить через «Поделиться»." }
    private fun attach(uri: Uri) { val p = getSharedPreferences("live_bridge", 0); val url = p.getString("url", "") ?: ""; if (url.isBlank()) { Toast.makeText(this, "Сначала подключи канал «телефон ↔ Copilot».", Toast.LENGTH_LONG).show(); return }; Thread { val bridge = LiveBridge(this) {}; bridge.configure(url, p.getString("token", "") ?: ""); bridge.start(); Thread.sleep(700); val ok = bridge.sendAttachment(uri); runOnUiThread { Toast.makeText(this, if (ok) "Материал отправлен Copilot" else "Не удалось отправить материал", Toast.LENGTH_SHORT).show() }; bridge.stop() }.start() }
    private fun handleIncomingIntent(i: Intent?) { if (i?.action == Intent.ACTION_SEND) i.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let(::attach) else if (i?.action == Intent.ACTION_SEND_MULTIPLE) i.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.forEach(::attach) }
    private fun requestBatteryOptimizationExemption() { if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return; try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + packageName))) } catch (_: Exception) { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } }
    private fun requestCapture() { if (!Settings.canDrawOverlays(this)) { Toast.makeText(this, "Сначала разреши «показывать поверх других приложений».", Toast.LENGTH_LONG).show(); startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + packageName))); return }; val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager; startActivityForResult(mgr.createScreenCaptureIntent(), captureCode) }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) { super.onActivityResult(requestCode, resultCode, data); if (requestCode == captureCode) { if (resultCode == Activity.RESULT_OK && data != null) { try { val serviceIntent = Intent(this, ScreenMonitorService::class.java).putExtra("resultCode", resultCode).putExtra("data", data); if (Build.VERSION.SDK_INT >= 26) startForegroundService(serviceIntent) else startService(serviceIntent) } catch (e: Exception) { Toast.makeText(this, "Не удалось запустить мониторинг: ${e.message}", Toast.LENGTH_LONG).show() } } else Toast.makeText(this, "Захват экрана отменён.", Toast.LENGTH_SHORT).show() } }
    private fun showBridgeDialog() { val p = getSharedPreferences("live_bridge", 0); val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(20,0,20,0) }; val url = EditText(this).apply { hint = "wss://адрес-моста/ws"; setText(p.getString("url", "") ?: "") }; val token = EditText(this).apply { hint = "Секретный ключ"; setText(p.getString("token", "") ?: "") }; box.addView(url); box.addView(token); AlertDialog.Builder(this).setTitle("Канал «телефон ↔ Copilot»").setMessage("Один постоянный канал для состояния игры и отправки материалов.").setView(box).setNegativeButton("Отмена", null).setPositiveButton("Сохранить") { _, _ -> LiveBridge(this) {}.configure(url.text.toString(), token.text.toString()); Toast.makeText(this, "Канал сохранён", Toast.LENGTH_SHORT).show() }.show() }
}