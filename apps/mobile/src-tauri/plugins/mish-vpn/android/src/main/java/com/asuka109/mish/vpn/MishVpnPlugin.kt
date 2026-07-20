package com.asuka109.mish.vpn

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin(
    permissions = [
        Permission(
            strings = [Manifest.permission.POST_NOTIFICATIONS],
            alias = "notifications",
        ),
    ],
)
class MishVpnPlugin(private val activity: Activity) : Plugin(activity) {
    private val store = MishVpnStateStore(activity)
    private var receiverRegistered = false
    private val snapshotReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val encoded = intent?.getStringExtra(MishVpnStateStore.EXTRA_EVENT) ?: return
            trigger("snapshot", JSObject(encoded))
        }
    }

    override fun load(webView: WebView) {
        registerSnapshotReceiver()
    }

    override fun onResume() {
        reconcilePermissions()
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (!receiverRegistered) return
        this.activity.unregisterReceiver(snapshotReceiver)
        receiverRegistered = false
    }

    @Command
    fun getSnapshot(invoke: Invoke) {
        invoke.resolveObject(reconcilePermissions())
    }

    @Command
    fun register_listener(invoke: Invoke) {
        registerListener(invoke)
    }

    @Command
    fun remove_listener(invoke: Invoke) {
        removeListener(invoke)
    }

    @Command
    fun requestVpnConsent(invoke: Invoke) {
        val consentIntent = VpnService.prepare(activity)
        if (consentIntent == null) {
            invoke.resolveObject(updateVpnPermission(true, "Android VPN permission is granted."))
            return
        }
        store.update {
            it.copy(
                message = "Waiting for explicit Android VPN permission.",
                permission = "required",
                phase = VpnPhase.PERMISSION_REQUIRED.wireName,
            )
        }
        startActivityForResult(invoke, consentIntent, "vpnConsentResult")
    }

    @ActivityCallback
    fun vpnConsentResult(invoke: Invoke, result: ActivityResult) {
        val granted = result.resultCode == Activity.RESULT_OK && VpnService.prepare(activity) == null
        val message = if (granted) {
            "Android VPN permission is granted. The fixture has not started a VPN."
        } else {
            "Android VPN permission was not granted. No service or traffic capture was started."
        }
        invoke.resolveObject(updateVpnPermission(granted, message))
    }

    @Command
    fun requestNotificationPermission(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasNotificationPermission()) {
            invoke.resolveObject(reconcilePermissions())
            return
        }
        requestPermissionForAlias("notifications", invoke, "notificationPermissionResult")
    }

    @PermissionCallback
    fun notificationPermissionResult(invoke: Invoke) {
        val granted = hasNotificationPermission()
        val snapshot = store.update {
            it.copy(
                message = if (granted) {
                    "Notification permission is granted for foreground VPN status."
                } else {
                    "Notification permission is denied. Android may show foreground status only in Task Manager."
                },
                notificationPermission = if (granted) "granted" else "denied",
            )
        }
        invoke.resolveObject(snapshot)
    }

    @Command
    fun startFixtureLifecycle(invoke: Invoke) {
        if (VpnService.prepare(activity) != null) {
            invoke.resolveObject(
                updateVpnPermission(
                    false,
                    "Android VPN permission is required. Request it explicitly before starting.",
                ),
            )
            return
        }
        val intent = Intent(activity, MishVpnService::class.java).setAction(MishVpnService.ACTION_START)
        ContextCompat.startForegroundService(activity, intent)
        invoke.resolveObject(reconcilePermissions())
    }

    @Command
    fun stop(invoke: Invoke) {
        val intent = Intent(activity, MishVpnService::class.java).setAction(MishVpnService.ACTION_STOP)
        activity.startService(intent)
        invoke.resolveObject(reconcilePermissions())
    }

    private fun reconcilePermissions(): MobileVpnSnapshot {
        if (!ProcessRuntimeRegistry.serviceActive) store.recoverAfterProcessStart()
        val current = store.current()
        val vpnPermission = if (VpnService.prepare(activity) == null) "granted" else "required"
        val notificationPermission = when {
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU -> "not-required"
            hasNotificationPermission() -> "granted"
            current.notificationPermission == "denied" -> "denied"
            else -> "required"
        }
        if (
            current.permission == vpnPermission &&
            current.notificationPermission == notificationPermission
        ) {
            return current
        }
        return store.update {
            it.copy(
                notificationPermission = notificationPermission,
                permission = vpnPermission,
                phase = if (
                    vpnPermission == "required" &&
                    it.phase !in setOf(
                        VpnPhase.STARTING.wireName,
                        VpnPhase.RUNNING.wireName,
                        VpnPhase.STOPPING.wireName,
                        VpnPhase.RECOVERY_REQUIRED.wireName,
                    )
                ) {
                    VpnPhase.PERMISSION_REQUIRED.wireName
                } else {
                    it.phase
                },
            )
        }
    }

    private fun updateVpnPermission(granted: Boolean, message: String): MobileVpnSnapshot =
        store.update {
            it.copy(
                message = message,
                permission = if (granted) "granted" else "required",
                phase = if (granted) VpnPhase.STOPPED.wireName else VpnPhase.PERMISSION_REQUIRED.wireName,
                vpnActive = false,
            )
        }

    private fun hasNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED

    private fun registerSnapshotReceiver() {
        if (receiverRegistered) return
        val filter = IntentFilter(MishVpnStateStore.ACTION_SNAPSHOT_CHANGED)
        ContextCompat.registerReceiver(
            activity,
            snapshotReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        receiverRegistered = true
    }
}
