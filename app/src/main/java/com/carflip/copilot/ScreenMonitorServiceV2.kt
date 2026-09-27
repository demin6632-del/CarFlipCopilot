package com.carflip.copilot

import android.app.Service
import android.content.Intent
import android.os.IBinder

/** Compatibility service kept intentionally small. The live capture/overlay implementation lives in ScreenMonitorService. */
class ScreenMonitorServiceV2 : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_NOT_STICKY
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
