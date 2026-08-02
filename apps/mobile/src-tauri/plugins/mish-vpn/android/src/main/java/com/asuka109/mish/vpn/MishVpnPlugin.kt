package com.asuka109.mish.vpn

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.SystemClock
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
import java.util.concurrent.ExecutorService

@TauriPlugin(
    permissions = [
        Permission(
            strings = [Manifest.permission.POST_NOTIFICATIONS],
            alias = "notifications",
        ),
    ],
)
class MishVpnPlugin(private val activity: Activity) : Plugin(activity) {
    private val failureInjectionAvailable =
        activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
    private val coreRuntime = MobileCoreProcessRuntimeRegistry.acquire(
        activity,
        allowFailureInjection = failureInjectionAvailable,
    )
    private val coreProbe = coreRuntime.coreProbe
    private val store = coreRuntime.store
    private val validationCoordinator = coreRuntime.validationCoordinator
    private val loadCoordinator = coreRuntime.loadCoordinator
    private val configExecutor: ExecutorService = coreRuntime.configExecutor
    private val platformExecutor: ExecutorService = coreRuntime.platformExecutor
    private var receiverRegistered = false
    private val factsReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val encoded = intent?.getStringExtra(MishVpnPlatformStore.EXTRA_FACTS) ?: return
            trigger("facts", JSObject(encoded))
        }
    }

    override fun load(webView: WebView) {
        registerFactsReceiver()
    }

    override fun onResume() {
        observePlatformFacts()
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (receiverRegistered) {
            this.activity.unregisterReceiver(factsReceiver)
            receiverRegistered = false
        }
    }

    @Command
    fun getPlatformFacts(invoke: Invoke) {
        invoke.resolveObject(observePlatformFacts())
    }

    @Command
    fun requestVpnConsent(invoke: Invoke) {
        val consentIntent = VpnService.prepare(activity)
        if (consentIntent == null) {
            invoke.resolveObject(store.consentResult(true))
            return
        }
        startActivityForResult(invoke, consentIntent, "vpnConsentResult")
    }

    @ActivityCallback
    fun vpnConsentResult(invoke: Invoke, result: ActivityResult) {
        val granted = result.resultCode == Activity.RESULT_OK && VpnService.prepare(activity) == null
        invoke.resolveObject(store.consentResult(granted))
    }

    @Command
    fun requestNotificationPermission(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasNotificationPermission()) {
            invoke.resolveObject(observePlatformFacts())
            return
        }
        requestPermissionForAlias("notifications", invoke, "notificationPermissionResult")
    }

    @PermissionCallback
    fun notificationPermissionResult(invoke: Invoke) {
        invoke.resolveObject(store.notificationResult(hasNotificationPermission()))
    }

    @Command
    fun startPlatformLifecycle(invoke: Invoke) {
        val observed = observePlatformFacts()
        if (observed.vpnPermission != "granted") {
            invoke.resolveObject(observed)
            return
        }
        val intent = Intent(activity, MishVpnService::class.java).setAction(MishVpnService.ACTION_START)
        val initialSequence = observed.factSequence
        runCatching { ContextCompat.startForegroundService(activity, intent) }
            .onFailure {
                invoke.resolveObject(store.current())
                return
            }
        resolveAfterPlatformEffect(invoke, initialSequence) { it.serviceForeground }
    }

    @Command
    fun stopPlatformLifecycle(invoke: Invoke) {
        val observed = observePlatformFacts()
        if (!observed.serviceForeground && !ProcessRuntimeRegistry.serviceActive) {
            invoke.resolveObject(store.serviceStopped())
            return
        }
        val intent = Intent(activity, MishVpnService::class.java).setAction(MishVpnService.ACTION_STOP)
        val initialSequence = observed.factSequence
        runCatching { activity.startService(intent) }
            .onFailure {
                invoke.resolveObject(store.current())
                return
            }
        resolveAfterPlatformEffect(invoke, initialSequence) { !it.serviceForeground }
    }

    @Command
    fun validateConfig(invoke: Invoke) {
        val args = runCatching { invoke.parseArgs(ValidateConfigArgs::class.java) }
            .getOrElse {
                invoke.resolveObject(
                    MobileConfigValidationResult.failure(
                        store.current(),
                        "plugin-failure",
                        "The Android validation plugin rejected malformed command input.",
                    ),
                )
                return
            }
        runCatching {
            configExecutor.execute {
                invoke.resolveObject(
                    validateConfigSafely(validationCoordinator, args, store::current),
                )
            }
        }.onFailure {
            invoke.resolveObject(
                MobileConfigValidationResult.failure(
                    store.current(),
                    "plugin-failure",
                    "The Android validation plugin is unavailable.",
                ),
            )
        }
    }

    @Command
    fun loadConfig(invoke: Invoke) {
        val args = runCatching { invoke.parseArgs(LoadConfigArgs::class.java) }
            .getOrElse {
                invoke.resolveObject(loadConfigFailure(LoadConfigArgs(), store.current()))
                return
            }
        runCatching {
            configExecutor.execute {
                invoke.resolveObject(loadConfigSafely(loadCoordinator, args, store::current))
            }
        }.onFailure {
            invoke.resolveObject(loadConfigFailure(args, store.current()))
        }
    }

    @Command
    fun cancelConfigLoad(invoke: Invoke) {
        val args = runCatching { invoke.parseArgs(CancelConfigLoadArgs::class.java) }
            .getOrElse {
                invoke.resolveObject(MobileConfigCancelResult(false, operationId = ""))
                return
            }
        invoke.resolveObject(loadCoordinator.cancel(args.operationId))
    }

    private fun observePlatformFacts(): MobilePlatformFacts {
        val vpnPermission = if (VpnService.prepare(activity) == null) "granted" else "required"
        val current = store.current()
        val notificationPermission = when {
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU -> "not-required"
            hasNotificationPermission() -> "granted"
            current.notificationPermission == "denied" -> "denied"
            else -> "required"
        }
        store.reconcilePermissions(vpnPermission, notificationPermission)
        store.reconcileCore(coreProbe.inspect())
        store.reconcileFailureInjection(failureInjectionAvailable)
        val expectedDigest = store.current().loadedConfigDigest
        return store.reconcileLoadedConfig(coreProbe.inspectLoaded(expectedDigest))
    }

    private fun resolveAfterPlatformEffect(
        invoke: Invoke,
        initialSequence: Long,
        completed: (MobilePlatformFacts) -> Boolean,
    ) {
        runCatching {
            platformExecutor.execute {
                val deadline = SystemClock.elapsedRealtime() + PLATFORM_EFFECT_TIMEOUT_MILLIS
                var current = store.current()
                while (
                    (current.factSequence <= initialSequence || !completed(current)) &&
                    SystemClock.elapsedRealtime() < deadline
                ) {
                    Thread.sleep(10)
                    current = store.current()
                }
                invoke.resolveObject(current)
            }
        }.onFailure { invoke.resolveObject(store.current()) }
    }

    private fun hasNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED

    private fun registerFactsReceiver() {
        if (receiverRegistered) return
        val filter = IntentFilter(MishVpnPlatformStore.ACTION_FACTS_CHANGED)
        ContextCompat.registerReceiver(
            activity,
            factsReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        receiverRegistered = true
    }

    private companion object {
        const val PLATFORM_EFFECT_TIMEOUT_MILLIS = 5_000L
    }
}
