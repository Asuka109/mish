package com.asuka109.mish.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.annotation.Keep
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class MishVpnService : VpnService() {
    private lateinit var connectivity: ConnectivityManager
    private lateinit var core: MishMobileCoreProbe
    private lateinit var executor: ScheduledExecutorService
    private lateinit var store: MishVpnPlatformStore
    private val serviceInstanceId = UUID.randomUUID().toString()
    /** Sticky for the service instance: callbacks must not reacquire effects once cleanup owns it. */
    private val cleanupRequested = AtomicBoolean(false)
    private val cleanupInProgress = AtomicBoolean(false)
    private val stopRequested = AtomicBoolean(false)
    private val cleanup = MishVpnOwnedResourceCleanup()
    private val protectedSocketFacts = ProtectedSocketFactGate()
    private val underlyingNetworks = linkedSetOf<Network>()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var productSessionId: String? = null
    private var activeLifecycleAuthority: CoreLifecycleAuthority? = null
    private var requestedStopAuthority: CoreLifecycleAuthority? = null
    private var tunDescriptor: ParcelFileDescriptor? = null
    @Volatile
    private var explicitCleanup = false

    override fun onCreate() {
        super.onCreate()
        val allowFailureInjection = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        val runtime = MobileCoreProcessRuntimeRegistry.acquire(
            this,
            allowFailureInjection = allowFailureInjection,
        )
        core = runtime.coreProbe
        store = runtime.store
        val recovered = store.current()
        activeLifecycleAuthority = recovered.lifecycleAuthority
        productSessionId = recovered.activationSessionId
        connectivity = getSystemService(ConnectivityManager::class.java)
        ProcessRuntimeRegistry.serviceActive = true
        executor = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "mish-vpn-platform-effects").apply { isDaemon = true }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val request = ActivationRequest.fromIntent(intent)
                if (request == null) {
                    // Malformed or stale intents are ignored. They do not own
                    // the current service and must not clean another session.
                    return START_NOT_STICKY
                } else {
                    executor.execute { activate(request, startId) }
                }
            }
            ACTION_STOP -> {
                val authority = lifecycleAuthorityFromIntent(intent)
                val currentAuthority = store.current().lifecycleAuthority ?: activeLifecycleAuthority
                if (authority != null &&
                    (authority == currentAuthority || lifecycleAuthorityIsSuccessor(authority, currentAuthority))
                ) {
                    val authorityAdvanced = runCatching {
                        store.lifecycleAuthorityAdvanced(serviceInstanceId, authority)
                    }.getOrDefault(false)
                    if (authorityAdvanced) {
                        requestedStopAuthority = authority
                        stopRequested.set(true)
                        executor.execute { stopExplicitly(startId) }
                    }
                }
            }
            else -> {
                // Unknown/null actions are not lifecycle authority. Let the
                // normal service-destruction path reconcile owned state.
                return START_NOT_STICKY
            }
        }
        return START_NOT_STICKY
    }

    private fun activate(request: ActivationRequest, startId: Int) {
        if (cleanupRequested.get()) {
            return
        }
        val initial = store.current()
        if (!lifecycleAuthorityMatchesOrIsSuccessor(
                request.lifecycleAuthority,
                initial.lifecycleAuthority,
            )
        ) {
            // A stale replacement callback cannot mutate or clean the current
            // owner. Rust will reconcile the unchanged facts and issue the
            // valid successor cleanup if needed.
            return
        }
        val preflightFailure = when {
            initial.recoveryEvidence != PlatformRecoveryEvidence.NONE.wireName ->
                PlatformFailureKind.CONFIGURATION_NOT_LOADED
            VpnService.prepare(this) != null -> PlatformFailureKind.PERMISSION_REVOKED
            initial.platformSessionId != request.platformSessionId ||
                initial.factSequence != request.factSequence -> PlatformFailureKind.CONFIGURATION_NOT_LOADED
            !core.admission().admitted -> PlatformFailureKind.CORE_UNAVAILABLE
            initial.coreAvailability != "available" -> PlatformFailureKind.CORE_UNAVAILABLE
            initial.coreConfigState != "loaded" ||
                initial.loadedConfigDigest != request.configDigest ||
                initial.loadedConfigRevision != request.configRevision ->
                PlatformFailureKind.CONFIGURATION_NOT_LOADED
            else -> null
        }
        if (preflightFailure != null) {
            publishFailedActivation(preflightFailure, startId, request.productSessionId)
            return
        }

        val authorityAdmitted = runCatching {
            store.acquireLifecycleAuthority(serviceInstanceId, request.lifecycleAuthority)
        }.getOrDefault(false)
        if (!authorityAdmitted) {
            return
        }

        productSessionId = request.productSessionId
        activeLifecycleAuthority = request.lifecycleAuthority
        stopRequested.set(false)

        try {
            // Persisted authority is the gate for every platform effect. The
            // foreground notification is intentionally promoted only after
            // activationStarting has recorded that authority.
            store.activationStarting(
                serviceInstanceId,
                request.productSessionId,
                request.lifecycleAuthority,
            )
            promoteToForeground()
            store.foregroundStarted()
            registerUnderlyingNetworkObservation()
            if (!awaitUnderlyingNetwork()) {
                if (stopRequested.get()) return
                failAfterCleanup(PlatformFailureKind.NETWORK_UNAVAILABLE, startId)
                return
            }
            if (!activationAuthorityStillValid(request)) {
                if (stopRequested.get()) return
                failAfterCleanup(PlatformFailureKind.CONFIGURATION_NOT_LOADED, startId)
                return
            }

            val descriptor = establishTun() ?: run {
                failAfterCleanup(PlatformFailureKind.TUN_ESTABLISH_FAILED, startId)
                return
            }
            tunDescriptor = descriptor
            store.tunEstablished()

            if (!activationAuthorityStillValid(request)) {
                if (stopRequested.get()) return
                failAfterCleanup(PlatformFailureKind.CONFIGURATION_NOT_LOADED, startId)
                return
            }
            val started = core.start(
                request.lifecycleAuthority,
                request.productSessionId,
                descriptor.fd,
                this,
            )
            if (started.code != NativeRuntimeCode.RUNNING) {
                failAfterCleanup(mapCoreStartFailure(started.code), startId)
                return
            }
            store.coreStarted()

            if (!awaitPublicRequest() || store.current().protectedSocketCount == 0L) {
                if (stopRequested.get()) return
                failAfterCleanup(PlatformFailureKind.PUBLIC_REQUEST_FAILED, startId)
                return
            }
            if (stopRequested.get()) return
            store.activationCompleted()
            scheduleCoreWatchdog(request.productSessionId)
        } catch (_: Throwable) {
            failAfterCleanup(PlatformFailureKind.CORE_START_FAILED, startId)
        }
    }

    private fun establishTun(): ParcelFileDescriptor? {
        if (
            !::store.isInitialized ||
                cleanupRequested.get() ||
                stopRequested.get() ||
                store.current().lifecycleAuthority == null
        ) return null
        return runCatching {
            val networks = usableUnderlyingNetworks()
            val builder = Builder()
                .setSession(getString(R.string.mish_vpn_notification_title))
                .setMtu(TUN_MTU)
                .addAddress(TUN_IPV4_ADDRESS, TUN_IPV4_PREFIX)
                .addAddress(TUN_IPV6_ADDRESS, TUN_IPV6_PREFIX)
                .addDnsServer(TUN_IPV4_DNS)
                .addRoute("0.0.0.0", 0)
                .addRoute("::", 0)
                .setUnderlyingNetworks(networks)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) builder.setMetered(false)
            builder.establish()
        }.getOrNull()
    }

    private fun registerUnderlyingNetworkObservation() {
        if (networkCallback != null) return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val changed = synchronized(underlyingNetworks) { underlyingNetworks.add(network) }
                if (changed) executor.execute { reconcileUnderlyingNetworks() }
            }

            override fun onLost(network: Network) {
                val changed = synchronized(underlyingNetworks) { underlyingNetworks.remove(network) }
                if (changed) executor.execute { reconcileUnderlyingNetworks() }
            }
        }
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            .build()
        connectivity.registerNetworkCallback(request, callback)
        networkCallback = callback
        val initial = connectivity.allNetworks.filter(::isUsableUnderlyingNetwork)
        synchronized(underlyingNetworks) { underlyingNetworks.addAll(initial) }
    }

    private fun awaitUnderlyingNetwork(): Boolean {
        val deadline = android.os.SystemClock.elapsedRealtime() + NETWORK_WAIT_MILLIS
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            if (stopRequested.get()) return false
            if (usableUnderlyingNetworks().isNotEmpty()) {
                store.networkChanged(true)
                return true
            }
            Thread.sleep(25)
        }
        store.networkChanged(false)
        return false
    }

    private fun reconcileUnderlyingNetworks() {
        if (
            cleanupRequested.get() ||
                stopRequested.get() ||
                store.current().lifecycleAuthority == null
        ) return
        val networks = usableUnderlyingNetworks()
        if (tunDescriptor != null) setUnderlyingNetworks(networks)
        store.networkChanged(networks.isNotEmpty())
        if (networks.isNotEmpty() && store.current().coreRunning) {
            if (awaitPublicRequest()) store.activationCompleted()
        }
    }

    private fun usableUnderlyingNetworks(): Array<Network> = synchronized(underlyingNetworks) {
        underlyingNetworks.removeAll { network -> !isUsableUnderlyingNetwork(network) }
        underlyingNetworks.toTypedArray()
    }

    private fun isUsableUnderlyingNetwork(network: Network): Boolean =
        connectivity.getNetworkCapabilities(network)?.let { capabilities ->
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        } == true

    private fun awaitPublicRequest(): Boolean {
        val deadline = android.os.SystemClock.elapsedRealtime() + PUBLIC_PROBE_WAIT_MILLIS
        do {
            if (stopRequested.get()) return false
            if (observePublicRequest()) return true
            Thread.sleep(PUBLIC_PROBE_RETRY_MILLIS)
        } while (android.os.SystemClock.elapsedRealtime() < deadline)
        return false
    }

    private fun observePublicRequest(): Boolean = runCatching {
        val connection = URL(PUBLIC_PROBE_URL).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = PUBLIC_PROBE_TIMEOUT_MILLIS
            connection.readTimeout = PUBLIC_PROBE_TIMEOUT_MILLIS
            connection.instanceFollowRedirects = false
            connection.requestMethod = "GET"
            connection.useCaches = false
            connection.connect()
            connection.responseCode in 200..399
        } finally {
            connection.disconnect()
        }
    }.getOrDefault(false)

    @Keep
    fun protectSocket(fileDescriptor: Int): Boolean {
        if (
            !::store.isInitialized ||
                cleanupRequested.get() ||
                stopRequested.get() ||
                store.current().lifecycleAuthority == null
        ) return false
        val protected = runCatching { protect(fileDescriptor) }.getOrDefault(false)
        if (cleanupRequested.get() || stopRequested.get()) return protected
        return protectedSocketFacts.record(protected) { store.protectedSocketObserved() }
    }

    private fun scheduleCoreWatchdog(sessionId: String) {
        executor.scheduleWithFixedDelay(
            {
                if (cleanupRequested.get()) return@scheduleWithFixedDelay
                if (core.inspectRuntime(sessionId).code != NativeRuntimeCode.RUNNING) {
                    explicitCleanup = true
                    val cleaned = cleanupOwnedResources()
                    if (cleaned) store.coreExited() else store.serviceDestroyed(false)
                    finishForeground()
                }
            },
            CORE_WATCHDOG_MILLIS,
            CORE_WATCHDOG_MILLIS,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun stopExplicitly(startId: Int) {
        explicitCleanup = true
        val cleaned = cleanupOwnedResources()
        if (cleaned) store.serviceStopped() else store.serviceDestroyed(false)
        finishForeground(startId)
    }

    private fun failAfterCleanup(failure: PlatformFailureKind, startId: Int) {
        explicitCleanup = true
        val cleaned = cleanupOwnedResources()
        if (cleaned) {
            store.activationFailed(failure)
        } else {
            store.serviceDestroyed(false)
        }
        finishForeground(startId)
    }

    private fun publishFailedActivation(
        failure: PlatformFailureKind,
        startId: Int,
        productSessionId: String? = null,
    ) {
        explicitCleanup = true
        val facts = store.current()
        val invalidRecovery = facts.recoveryEvidence == PlatformRecoveryEvidence.INVALID.wireName
        val ownsResources = facts.lifecycleAuthority != null ||
            facts.recoveryEvidence != PlatformRecoveryEvidence.NONE.wireName ||
            facts.activeNetwork || facts.coreRunning || facts.tunEstablished ||
            facts.serviceForeground || facts.activationSessionId != null
        if (invalidRecovery && facts.lifecycleAuthority == null) {
            store.serviceDestroyed(false)
        } else if (ownsResources) {
            val cleaned = cleanupOwnedResources()
            if (cleaned) {
                store.activationFailed(failure, productSessionId)
            } else {
                // Keep the authority and recovery evidence. A malformed or
                // stale intent must never turn an owned platform into clean.
                store.serviceDestroyed(false)
            }
        } else {
            store.activationFailed(failure, productSessionId)
        }
        finishForeground(startId)
    }

    private fun cleanupOwnedResources(): Boolean {
        cleanupRequested.set(true)
        if (!cleanupInProgress.compareAndSet(false, true)) {
            return cleanup.isComplete()
        }
        try {
            val initialFacts = store.current()
            if (
                initialFacts.recoveryEvidence == PlatformRecoveryEvidence.INVALID.wireName &&
                    initialFacts.lifecycleAuthority == null
            ) {
                // A malformed durable record has no safe authority with which
                // to address native ownership. Preserve explicit recovery
                // evidence until Rust issues an authority-bearing cleanup.
                return false
            }
            val session = productSessionId
            val activeAuthority = activeLifecycleAuthority
            val authority = requestedStopAuthority ?: activeAuthority?.nextEffect()
            if (authority != null && store.current().lifecycleAuthority != authority) {
                val authorityAdvanced = runCatching {
                    store.lifecycleAuthorityAdvanced(serviceInstanceId, authority)
                }.getOrDefault(false)
                if (!authorityAdvanced) return false
            }
            val cleaned = cleanup.cleanup(
                stopCore = {
                    if (activeAuthority != null && authority == null) {
                        false
                    } else {
                        authority == null || core.stop(authority, session).code in setOf(
                            NativeRuntimeCode.INACTIVE,
                            NativeRuntimeCode.CORE_UNAVAILABLE,
                        )
                    }
                },
                closeTun = {
                    val descriptor = tunDescriptor
                    if (descriptor == null) {
                        true
                    } else {
                        runCatching { descriptor.close() }
                            .onSuccess { tunDescriptor = null }
                            .isSuccess
                    }
                },
                unregisterNetwork = {
                    val callback = networkCallback
                    val released = callback == null ||
                        runCatching { connectivity.unregisterNetworkCallback(callback) }.isSuccess
                    if (released) {
                        networkCallback = null
                        synchronized(underlyingNetworks) { underlyingNetworks.clear() }
                    }
                    released
                },
            )
            if (cleaned) {
                productSessionId = null
                activeLifecycleAuthority = null
                requestedStopAuthority = null
                protectedSocketFacts.reset()
            }
            return cleaned
        } finally {
            cleanupInProgress.set(false)
        }
    }

    private fun activationAuthorityStillValid(request: ActivationRequest): Boolean {
        val current = store.current()
        return VpnService.prepare(this) == null &&
            !stopRequested.get() &&
            current.activationSessionId == request.productSessionId &&
            current.lifecycleAuthority == request.lifecycleAuthority &&
            current.coreAvailability == "available" &&
            current.coreConfigState == "loaded" &&
            current.loadedConfigDigest == request.configDigest &&
            current.loadedConfigRevision == request.configRevision &&
            usableUnderlyingNetworks().isNotEmpty()
    }

    override fun onRevoke() {
        executor.execute {
            explicitCleanup = true
            val cleaned = cleanupOwnedResources()
            if (cleaned) store.revoked() else store.serviceDestroyed(false)
            finishForeground()
        }
        super.onRevoke()
    }

    override fun onDestroy() {
        if (::executor.isInitialized) {
            val cleaned = runCatching {
                executor.submit<Boolean> { cleanupOwnedResources() }
                    .get(DESTROY_CLEANUP_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
            }.getOrDefault(false)
            if (::store.isInitialized) {
                val currentFacts = store.current()
                val invalidRecovery = currentFacts.recoveryEvidence == PlatformRecoveryEvidence.INVALID.wireName
                val stillOwned = currentFacts.let { facts ->
                    facts.lifecycleAuthority != null ||
                        facts.recoveryEvidence != PlatformRecoveryEvidence.NONE.wireName ||
                        facts.activeNetwork || facts.coreRunning || facts.tunEstablished ||
                        facts.serviceForeground || facts.activationSessionId != null
                }
                when {
                    invalidRecovery -> store.serviceDestroyed(false)
                    cleaned && stillOwned -> store.serviceStopped()
                    !explicitCleanup -> store.serviceDestroyed(cleaned)
                }
            }
            executor.shutdownNow()
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
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_mish_vpn_notification)
            .setContentTitle(getString(R.string.mish_vpn_notification_title))
            .setContentText(getString(R.string.mish_vpn_running_notification))
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(openPendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
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

    private fun mapCoreStartFailure(code: NativeRuntimeCode): PlatformFailureKind = when (code) {
        NativeRuntimeCode.NOT_LOADED -> PlatformFailureKind.CONFIGURATION_NOT_LOADED
        NativeRuntimeCode.CORE_UNAVAILABLE -> PlatformFailureKind.CORE_UNAVAILABLE
        NativeRuntimeCode.PROTECTION_FAILED -> PlatformFailureKind.PUBLIC_REQUEST_FAILED
        else -> PlatformFailureKind.CORE_START_FAILED
    }

    private data class ActivationRequest(
        val configDigest: String,
        val configRevision: String,
        val factSequence: Long,
        val platformSessionId: String,
        val productSessionId: String,
        val lifecycleAuthority: CoreLifecycleAuthority,
    ) {
        companion object {
            fun fromIntent(intent: Intent): ActivationRequest? {
                val configDigest = intent.getStringExtra(EXTRA_CONFIG_DIGEST) ?: return null
                val configRevision = intent.getStringExtra(EXTRA_CONFIG_REVISION) ?: return null
                val platformSessionId = intent.getStringExtra(EXTRA_PLATFORM_SESSION_ID) ?: return null
                val productSessionId = intent.getStringExtra(EXTRA_PRODUCT_SESSION_ID) ?: return null
                val factSequence = intent.getLongExtra(EXTRA_FACT_SEQUENCE, -1)
                val lifecycleAuthority = lifecycleAuthorityFromIntent(intent) ?: return null
                if (
                    !configDigest.matches(DIGEST_PATTERN) ||
                    !configRevision.matches(IDENTIFIER_PATTERN) ||
                    !platformSessionId.matches(IDENTIFIER_PATTERN) ||
                    !productSessionId.matches(IDENTIFIER_PATTERN) ||
                    factSequence < 0
                ) {
                    return null
                }
                return ActivationRequest(
                    configDigest,
                    configRevision,
                    factSequence,
                    platformSessionId,
                    productSessionId,
                    lifecycleAuthority,
                )
            }
        }
    }

    companion object {
        const val ACTION_START = "com.asuka109.mish.vpn.action.START"
        const val ACTION_STOP = "com.asuka109.mish.vpn.action.STOP"
        const val EXTRA_CONFIG_DIGEST = "com.asuka109.mish.vpn.extra.CONFIG_DIGEST"
        const val EXTRA_CONFIG_REVISION = "com.asuka109.mish.vpn.extra.CONFIG_REVISION"
        const val EXTRA_FACT_SEQUENCE = "com.asuka109.mish.vpn.extra.FACT_SEQUENCE"
        const val EXTRA_PLATFORM_SESSION_ID = "com.asuka109.mish.vpn.extra.PLATFORM_SESSION_ID"
        const val EXTRA_PRODUCT_SESSION_ID = "com.asuka109.mish.vpn.extra.PRODUCT_SESSION_ID"
        const val EXTRA_MACHINE_AUTHORITY = "com.asuka109.mish.vpn.extra.MACHINE_AUTHORITY"
        const val EXTRA_SCOPE_EPOCH = "com.asuka109.mish.vpn.extra.SCOPE_EPOCH"
        const val EXTRA_OPERATION_ID = "com.asuka109.mish.vpn.extra.OPERATION_ID"
        const val EXTRA_ADMITTED_REVISION = "com.asuka109.mish.vpn.extra.ADMITTED_REVISION"
        const val EXTRA_EFFECT_IDENTITY = "com.asuka109.mish.vpn.extra.EFFECT_IDENTITY"
        private const val CHANNEL_ID = "mish-vpn-status-v1"
        private const val CORE_WATCHDOG_MILLIS = 2_000L
        private const val DESTROY_CLEANUP_TIMEOUT_MILLIS = 12_000L
        private const val NETWORK_WAIT_MILLIS = 5_000L
        private const val NOTIFICATION_ID = 4107
        private const val PUBLIC_PROBE_RETRY_MILLIS = 250L
        private const val PUBLIC_PROBE_TIMEOUT_MILLIS = 4_000
        private const val PUBLIC_PROBE_WAIT_MILLIS = 20_000L
        private const val PUBLIC_PROBE_URL = "http://1.1.1.1/cdn-cgi/trace"
        private const val REQUEST_OPEN = 4108
        private const val TUN_IPV4_ADDRESS = "172.19.0.1"
        private const val TUN_IPV4_DNS = "1.1.1.1"
        private const val TUN_IPV4_PREFIX = 30
        private const val TUN_IPV6_ADDRESS = "fdfe:dcba:9876::1"
        private const val TUN_IPV6_PREFIX = 126
        private const val TUN_MTU = 1500
        private val DIGEST_PATTERN = Regex("^[0-9a-f]{64}$")
        private val IDENTIFIER_PATTERN = Regex("^[A-Za-z0-9._-]{1,128}$")

        private fun lifecycleAuthorityFromIntent(intent: Intent): CoreLifecycleAuthority? {
            val machineAuthority = intent.getStringExtra(EXTRA_MACHINE_AUTHORITY) ?: return null
            val scopeEpoch = intent.getLongExtra(EXTRA_SCOPE_EPOCH, -1)
            val operationId = intent.getStringExtra(EXTRA_OPERATION_ID) ?: return null
            val admittedRevision = intent.getLongExtra(EXTRA_ADMITTED_REVISION, -1)
            val effectIdentity = intent.getStringExtra(EXTRA_EFFECT_IDENTITY) ?: return null
            if (
                !machineAuthority.matches(IDENTIFIER_PATTERN) ||
                scopeEpoch <= 0 ||
                !operationId.matches(IDENTIFIER_PATTERN) ||
                admittedRevision <= 0 ||
                !effectIdentity.matches(IDENTIFIER_PATTERN)
            ) return null
            return CoreLifecycleAuthority(
                machineAuthority,
                scopeEpoch,
                operationId,
                admittedRevision,
                effectIdentity,
            ).takeIf { it.isValid() }
        }

    }
}
