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
import org.json.JSONObject
import java.util.UUID
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
    private val authorityAdmissionId = "tauri-admission-${UUID.randomUUID()}"
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
    fun getCoreProvenance(invoke: Invoke) {
        invoke.resolveObject(coreProbe.provenanceSnapshot().toJson())
    }

    @Command
    fun getRouteSnapshot(invoke: Invoke) {
        invoke.resolveObject(MobileCoreRouteAdapter.execute(coreProbe, RouteOperationArgs()))
    }

    @Command
    fun selectRouteChild(invoke: Invoke) {
        val args = runCatching { invoke.parseArgs(RouteOperationArgs::class.java) }
            .getOrElse {
                invoke.resolveObject(MobileCoreRouteAdapter.execute(coreProbe, RouteOperationArgs()))
                return
            }
        invoke.resolveObject(MobileCoreRouteAdapter.execute(coreProbe, args))
    }

    @Command
    fun getTrafficSnapshot(invoke: Invoke) {
        invoke.resolveObject(
            JSObject(MobileCoreTrafficCommandAdapter.snapshot(coreProbe).toString()),
        )
    }

    @Command
    fun closeTrafficConnection(invoke: Invoke) {
        val args = runCatching { invoke.parseArgs(CloseTrafficConnectionArgs::class.java) }
            .getOrElse {
                invoke.resolveObject(
                    JSObject(
                        MobileCoreTrafficCommandAdapter.close(
                            coreProbe,
                            CloseTrafficConnectionArgs(),
                        ).toString(),
                    ),
                )
                return
            }
        invoke.resolveObject(
            JSObject(MobileCoreTrafficCommandAdapter.close(coreProbe, args).toString()),
        )
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
        val args = runCatching { invoke.parseArgs(StartLifecycleArgs::class.java) }
            .getOrElse {
                invoke.resolveObject(store.current())
                return
            }
        val observed = store.current()
        if (
            observed.vpnPermission != "granted" ||
            observed.recoveryEvidence != PlatformRecoveryEvidence.NONE.wireName ||
            observed.platformSessionId != args.platformSessionId ||
            observed.factSequence != args.factSequence ||
            observed.coreConfigState != "loaded" ||
            observed.loadedConfigDigest != args.configDigest ||
            observed.loadedConfigRevision != args.configRevision ||
            !args.configDigest.matches(DIGEST_PATTERN) ||
            !args.configRevision.matches(IDENTIFIER_PATTERN) ||
            !args.productSessionId.matches(IDENTIFIER_PATTERN) ||
            !validLifecycleAuthority(
                args.machineAuthority,
                args.scopeEpoch,
                args.operationId,
                args.admittedRevision,
                args.effectIdentity,
            )
        ) {
            invoke.resolveObject(observed)
            return
        }
        val lifecycleAuthority = CoreLifecycleAuthority(
            machineAuthority = args.machineAuthority,
            scopeEpoch = args.scopeEpoch,
            operationId = args.operationId,
            admittedRevision = args.admittedRevision,
            effectIdentity = args.effectIdentity,
        )
        val authorityAdmitted = runCatching {
            store.lifecycleAuthorityAdvanced(authorityAdmissionId, lifecycleAuthority)
        }.getOrDefault(false)
        if (!authorityAdmitted) {
            // A stale/foreign request must not even enqueue a foreground
            // service effect. Rust remains the only authority that can issue
            // the next valid generation.
            invoke.resolveObject(observed)
            return
        }
        val admittedFactSequence = store.current().factSequence
        val intent = Intent(activity, MishVpnService::class.java)
            .setAction(MishVpnService.ACTION_START)
            .putExtra(MishVpnService.EXTRA_CONFIG_DIGEST, args.configDigest)
            .putExtra(MishVpnService.EXTRA_CONFIG_REVISION, args.configRevision)
            .putExtra(MishVpnService.EXTRA_FACT_SEQUENCE, admittedFactSequence)
            .putExtra(MishVpnService.EXTRA_PLATFORM_SESSION_ID, args.platformSessionId)
            .putExtra(MishVpnService.EXTRA_PRODUCT_SESSION_ID, args.productSessionId)
            .putExtra(MishVpnService.EXTRA_MACHINE_AUTHORITY, args.machineAuthority)
            .putExtra(MishVpnService.EXTRA_SCOPE_EPOCH, args.scopeEpoch)
            .putExtra(MishVpnService.EXTRA_OPERATION_ID, args.operationId)
            .putExtra(MishVpnService.EXTRA_ADMITTED_REVISION, args.admittedRevision)
            .putExtra(MishVpnService.EXTRA_EFFECT_IDENTITY, args.effectIdentity)
        val initialSequence = observed.factSequence
        runCatching { ContextCompat.startForegroundService(activity, intent) }
            .onFailure {
                invoke.resolveObject(store.current())
                return
            }
        resolveAfterPlatformEffect(invoke, initialSequence) {
            it.event in setOf(
                PlatformEventKind.ACTIVATION_COMPLETED.wireName,
                PlatformEventKind.ACTIVATION_FAILED.wireName,
            )
        }
    }

    @Command
    fun stopPlatformLifecycle(invoke: Invoke) {
        val args = runCatching { invoke.parseArgs(StopLifecycleArgs::class.java) }
            .getOrElse {
                invoke.resolveObject(store.current())
                return
            }
        if (!validLifecycleAuthority(
                args.machineAuthority,
                args.scopeEpoch,
                args.operationId,
                args.admittedRevision,
                args.effectIdentity,
            )
        ) {
            invoke.resolveObject(store.current())
            return
        }
        val observed = observePlatformFacts()
        val platformClean = observed.lifecycleAuthority == null &&
            observed.recoveryEvidence == PlatformRecoveryEvidence.NONE.wireName &&
            !observed.activeNetwork &&
            !observed.coreRunning &&
            !observed.tunEstablished &&
            !observed.serviceForeground &&
            observed.activationSessionId == null
        if (platformClean && !ProcessRuntimeRegistry.serviceActive) {
            invoke.resolveObject(store.serviceStopped())
            return
        }
        val lifecycleAuthority = CoreLifecycleAuthority(
            machineAuthority = args.machineAuthority,
            scopeEpoch = args.scopeEpoch,
            operationId = args.operationId,
            admittedRevision = args.admittedRevision,
            effectIdentity = args.effectIdentity,
        )
        val authorityAdmitted = runCatching {
            store.lifecycleAuthorityAdvanced(authorityAdmissionId, lifecycleAuthority)
        }.getOrDefault(false)
        if (!authorityAdmitted) {
            invoke.resolveObject(observed)
            return
        }
        val intent = Intent(activity, MishVpnService::class.java)
            .setAction(MishVpnService.ACTION_STOP)
            .putExtra(MishVpnService.EXTRA_MACHINE_AUTHORITY, args.machineAuthority)
            .putExtra(MishVpnService.EXTRA_SCOPE_EPOCH, args.scopeEpoch)
            .putExtra(MishVpnService.EXTRA_OPERATION_ID, args.operationId)
            .putExtra(MishVpnService.EXTRA_ADMITTED_REVISION, args.admittedRevision)
            .putExtra(MishVpnService.EXTRA_EFFECT_IDENTITY, args.effectIdentity)
        val initialSequence = observed.factSequence
        runCatching { activity.startService(intent) }
            .onFailure {
                invoke.resolveObject(store.current())
                return
            }
        resolveAfterPlatformEffect(invoke, initialSequence) {
            it.event == PlatformEventKind.STOP_COMPLETED.wireName &&
                !it.serviceForeground &&
                !it.coreRunning &&
                !it.tunEstablished
        }
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
        val latest = store.current()
        if (latest.coreRunning) return latest
        return store.reconcileLoadedConfig(coreProbe.inspectLoaded(latest.loadedConfigDigest))
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
        fun validLifecycleAuthority(
            machineAuthority: String,
            scopeEpoch: Long,
            operationId: String,
            admittedRevision: Long,
            effectIdentity: String,
        ): Boolean =
            machineAuthority.matches(IDENTIFIER_PATTERN) &&
                scopeEpoch > 0 &&
                operationId.matches(IDENTIFIER_PATTERN) &&
                admittedRevision > 0 &&
                effectIdentity.matches(IDENTIFIER_PATTERN)

        const val PLATFORM_EFFECT_TIMEOUT_MILLIS = 30_000L
        val DIGEST_PATTERN = Regex("^[0-9a-f]{64}$")
        val IDENTIFIER_PATTERN = Regex("^[A-Za-z0-9._-]{1,128}$")
    }
}
