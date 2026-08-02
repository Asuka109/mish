package com.asuka109.mish.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class MishVpnService : VpnService() {
    private lateinit var executor: ExecutorService
    private lateinit var store: MishVpnPlatformStore
    private val serviceInstanceId = UUID.randomUUID().toString()
    @Volatile
    private var explicitCleanup = false

    override fun onCreate() {
        super.onCreate()
        val allowFailureInjection = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        store = MobileCoreProcessRuntimeRegistry.acquire(
            this,
            allowFailureInjection = allowFailureInjection,
        ).store
        ProcessRuntimeRegistry.serviceActive = true
        executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "mish-vpn-platform-effects").apply { isDaemon = true }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                promoteToForeground()
                executor.execute { store.serviceStarted(serviceInstanceId) }
            }
            ACTION_STOP -> executor.execute {
                explicitCleanup = true
                store.serviceStopped()
                finishForeground(startId)
            }
            else -> executor.execute {
                store.serviceDestroyed()
                finishForeground(startId)
            }
        }
        return START_NOT_STICKY
    }

    override fun onRevoke() {
        executor.execute {
            explicitCleanup = true
            store.revoked()
            finishForeground()
        }
        super.onRevoke()
    }

    override fun onDestroy() {
        if (::executor.isInitialized) {
            executor.shutdown()
            runCatching {
                if (!executor.awaitTermination(750, TimeUnit.MILLISECONDS)) executor.shutdownNow()
            }
        }
        if (::store.isInitialized && !explicitCleanup && store.current().serviceForeground) {
            store.serviceDestroyed()
        }
        ProcessRuntimeRegistry.serviceActive = false
        super.onDestroy()
    }

    private fun promoteToForeground() {
        createNotificationChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val openIntent = packageManager.getLaunchIntentForPackage(packageName)
        val openPendingIntent = PendingIntent.getActivity(
            this,
            REQUEST_OPEN,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = Intent(this, MishVpnService::class.java).setAction(ACTION_STOP)
        val stopPendingIntent = PendingIntent.getService(
            this,
            REQUEST_STOP,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_mish_vpn_notification)
            .setContentTitle(getString(R.string.mish_vpn_notification_title))
            .setContentText(getString(R.string.mish_vpn_fixture_notification))
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(openPendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .addAction(
                Notification.Action.Builder(
                    null,
                    getString(R.string.mish_vpn_stop),
                    stopPendingIntent,
                ).build(),
            )
            .build()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.mish_vpn_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.mish_vpn_channel_description)
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun finishForeground(startId: Int? = null) {
        stopForeground(Service.STOP_FOREGROUND_REMOVE)
        if (startId == null) stopSelf() else stopSelfResult(startId)
    }

    companion object {
        const val ACTION_START = "com.asuka109.mish.vpn.action.START"
        const val ACTION_STOP = "com.asuka109.mish.vpn.action.STOP"
        private const val CHANNEL_ID = "mish-vpn-status-v1"
        private const val NOTIFICATION_ID = 4107
        private const val REQUEST_OPEN = 4108
        private const val REQUEST_STOP = 4109
    }
}
