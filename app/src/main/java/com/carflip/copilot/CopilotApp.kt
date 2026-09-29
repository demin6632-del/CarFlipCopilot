package com.carflip.copilot

import android.app.Application
import android.os.Build
import java.io.PrintWriter
import java.io.StringWriter

class CopilotApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val sw = StringWriter()
                throwable.printStackTrace(PrintWriter(sw))
                getSharedPreferences("copilot_crash", MODE_PRIVATE).edit()
                    .putLong("time", System.currentTimeMillis())
                    .putString("thread", thread.name)
                    .putString("stack", sw.toString().take(12000))
                    .putString("sdk", Build.VERSION.SDK_INT.toString())
                    .putString("device", Build.MANUFACTURER + " " + Build.MODEL)
                    .apply()
            } catch (_: Throwable) {}
            try { previous?.uncaughtException(thread, throwable) } catch (_: Throwable) {}
        }
    }
}