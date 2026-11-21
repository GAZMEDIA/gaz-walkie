package com.gaz.walkie

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps GAZ Walkie alive in the background so you still hear your group with the
 * screen off. Shows an ongoing notification with a "Turn off" button.
 */
class WalkieService : Service() {

    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            android.os.Process.killProcess(android.os.Process.myPid())
            return START_NOT_STICKY
        }

        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Walkie-Talkie", NotificationManager.IMPORTANCE_LOW))

        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, WalkieService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("GAZ Walkie is on")
            .setContentText("Listening to your group. Tap to open.")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null as Icon?, "Turn off", stop).build())
            .build()

        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(1, notification)
            }
        } catch (_: Exception) {
            stopSelf()
            return START_NOT_STICKY
        }

        if (wake == null) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gaz:walkie").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (wifi == null) {
            val wm = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "gaz:walkie").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        try { wake?.release() } catch (_: Exception) {}
        try { wifi?.release() } catch (_: Exception) {}
        super.onDestroy()
    }

    companion object {
        const val CHANNEL = "walkie"
        const val ACTION_STOP = "com.gaz.walkie.STOP"
    }
}
