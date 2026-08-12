package com.asuka109.mish.vpn

import android.content.Context
import android.content.Intent
import org.json.JSONObject

internal interface PlatformFactRepository {
    fun current(): MobilePlatformFacts
    fun update(transform: (MobilePlatformFacts) -> MobilePlatformFacts): MobilePlatformFacts
}

internal object ProcessRuntimeRegistry {
    @Volatile
    var serviceActive = false
}

internal class MishVpnPlatformStore(context: Context) : PlatformFactRepository {
    private val applicationContext = context.applicationContext
    private val preferences = applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private var facts = initialFacts()

    init {
        // The unreleased Kotlin-owned product snapshot is deliberately deleted, not migrated.
        preferences.edit().remove(LEGACY_PRODUCT_SNAPSHOT).apply()
    }

    override fun current(): MobilePlatformFacts = synchronized(lock) { facts }

    override fun update(
        transform: (MobilePlatformFacts) -> MobilePlatformFacts,
    ): MobilePlatformFacts = publish(PlatformEventKind.OBSERVATION, transform)

    fun publish(
        event: PlatformEventKind,
        transform: (MobilePlatformFacts) -> MobilePlatformFacts,
    ): MobilePlatformFacts = synchronized(lock) {
        val transformed = transform(facts)
        val next = transformed.copy(
            event = event.wireName,
            factSequence = facts.factSequence + 1,
            observedAtMillis = System.currentTimeMillis(),
        )
        persistCoreEvidence(next)
        facts = next
        broadcast(next)
        next
    }

    fun reconcileCore(identity: MobileCoreIdentity?): MobilePlatformFacts {
        val current = current()
        val availability = if (identity == null) "unavailable" else "available"
        if (
            current.coreAvailability == availability &&
            current.coreAbiVersion == identity?.abiVersion &&
            current.coreCommit == identity?.commit &&
            current.coreVersion == identity?.version &&
            current.coreWrapperRevision == identity?.wrapperRevision
        ) {
            return current
        }
        return update {
            it.copy(
                coreAbiVersion = identity?.abiVersion,
                coreAvailability = availability,
                coreCommit = identity?.commit,
                coreVersion = identity?.version,
                coreWrapperRevision = identity?.wrapperRevision,
            )
        }
    }

    fun reconcileLoadedConfig(inspection: NativeConfigInspectionResult): MobilePlatformFacts {
        val current = current()
        val reconciled = reconcileCoreConfigFacts(current, inspection)
        if (
            current.coreConfigState == reconciled.coreConfigState &&
            current.loadedConfigDigest == reconciled.loadedConfigDigest &&
            current.loadedConfigRevision == reconciled.loadedConfigRevision
        ) {
            return current
        }
        return update { reconciled }
    }

    fun reconcileFailureInjection(available: Boolean): MobilePlatformFacts {
        val current = current()
        if (current.configFailureInjectionAvailable == available) return current
        return update { it.copy(configFailureInjectionAvailable = available) }
    }

    fun reconcilePermissions(
        vpnPermission: String,
        notificationPermission: String,
    ): MobilePlatformFacts {
        val current = current()
        if (
            current.vpnPermission == vpnPermission &&
            current.notificationPermission == notificationPermission
        ) {
            return current
        }
        return update {
            it.copy(
                notificationPermission = notificationPermission,
                vpnPermission = vpnPermission,
            )
        }
    }

    fun consentResult(granted: Boolean): MobilePlatformFacts =
        publish(PlatformEventKind.CONSENT_RESULT) {
            it.copy(vpnPermission = if (granted) "granted" else "required")
        }

    fun notificationResult(granted: Boolean): MobilePlatformFacts =
        publish(PlatformEventKind.NOTIFICATION_RESULT) {
            it.copy(notificationPermission = if (granted) "granted" else "denied")
        }

    fun activationStarting(
        serviceInstanceId: String,
        productSessionId: String,
        lifecycleAuthority: CoreLifecycleAuthority,
    ): MobilePlatformFacts {
        synchronized(lock) {
            check(acquireLifecycleAuthorityLocked(serviceInstanceId, lifecycleAuthority)) {
                "The Android lifecycle authority is stale or invalid."
            }
            ProcessRuntimeRegistry.serviceActive = true
            return publish(PlatformEventKind.ACTIVATION_PROGRESS) {
                it.copy(
                    activationFailure = null,
                    activationSessionId = productSessionId,
                    activeNetwork = false,
                    coreRunning = false,
                    dnsApplied = false,
                    lifecycleAuthority = lifecycleAuthority,
                    protectedSocketCount = 0,
                    publicRequestObserved = false,
                    recoveryEvidence = PlatformRecoveryEvidence.NONE.wireName,
                    routesApplied = false,
                    serviceForeground = false,
                    tunEstablished = false,
                )
            }
        }
    }

    /**
     * Persist the complete Rust-issued authority before any Android effect is
     * admitted. Kotlin may only accept an exact retry or the Rust-defined
     * successor; it never mints a new machine/scope/revision identity.
     */
    fun acquireLifecycleAuthority(
        serviceInstanceId: String,
        lifecycleAuthority: CoreLifecycleAuthority,
    ): Boolean = synchronized(lock) {
        acquireLifecycleAuthorityLocked(serviceInstanceId, lifecycleAuthority)
    }

    private fun acquireLifecycleAuthorityLocked(
        serviceInstanceId: String,
        lifecycleAuthority: CoreLifecycleAuthority,
    ): Boolean {
        if (!serviceInstanceId.matches(IDENTIFIER_PATTERN) || !lifecycleAuthority.isValid()) {
            return false
        }
        val currentAuthority = current().lifecycleAuthority
        if (!lifecycleAuthorityMatchesOrIsSuccessor(lifecycleAuthority, currentAuthority)) {
            return false
        }
        persistRecoveryRecord(serviceInstanceId, lifecycleAuthority)
        return true
    }

    fun foregroundStarted(): MobilePlatformFacts {
        synchronized(lock) {
            check(facts.lifecycleAuthority != null) {
                "Foreground service cannot start without persisted lifecycle authority."
            }
            return publish(PlatformEventKind.ACTIVATION_PROGRESS) {
                it.copy(serviceForeground = true)
            }
        }
    }

    fun lifecycleAuthorityAdvanced(
        serviceInstanceId: String,
        lifecycleAuthority: CoreLifecycleAuthority,
    ): Boolean = synchronized(lock) {
        if (!acquireLifecycleAuthorityLocked(serviceInstanceId, lifecycleAuthority)) return false
        publish(PlatformEventKind.OBSERVATION) {
            it.copy(lifecycleAuthority = lifecycleAuthority)
        }
        true
    }

    fun tunEstablished(): MobilePlatformFacts {
        synchronized(lock) {
            if (facts.lifecycleAuthority == null) return facts
            return publish(PlatformEventKind.ACTIVATION_PROGRESS) {
                it.copy(dnsApplied = true, routesApplied = true, tunEstablished = true)
            }
        }
    }

    fun coreStarted(): MobilePlatformFacts {
        synchronized(lock) {
            if (facts.lifecycleAuthority == null) return facts
            return publish(PlatformEventKind.ACTIVATION_PROGRESS) {
                it.copy(coreRunning = true)
            }
        }
    }

    fun protectedSocketObserved(): MobilePlatformFacts {
        synchronized(lock) {
            if (facts.lifecycleAuthority == null || facts.protectedSocketCount > 0) return facts
            return publish(PlatformEventKind.ACTIVATION_PROGRESS) {
                it.copy(protectedSocketCount = 1)
            }
        }
    }

    fun networkChanged(available: Boolean): MobilePlatformFacts {
        synchronized(lock) {
            if (facts.lifecycleAuthority == null) return facts
            return publish(PlatformEventKind.NETWORK_CHANGED) {
                it.copy(
                    activeNetwork = available,
                    publicRequestObserved = false,
                )
            }
        }
    }

    fun activationCompleted(): MobilePlatformFacts {
        synchronized(lock) {
            if (facts.lifecycleAuthority == null) return facts
            return publish(PlatformEventKind.ACTIVATION_COMPLETED) {
                it.copy(activationFailure = null, publicRequestObserved = true)
            }
        }
    }

    fun activationFailed(
        failure: PlatformFailureKind,
        productSessionId: String? = current().activationSessionId,
    ): MobilePlatformFacts {
        clearRecoveryRecord()
        ProcessRuntimeRegistry.serviceActive = false
        return publish(PlatformEventKind.ACTIVATION_FAILED) {
            cleanedFacts(it).copy(
                activationFailure = failure.wireName,
                activationSessionId = productSessionId,
            )
        }
    }

    fun serviceStopped(): MobilePlatformFacts {
        clearRecoveryRecord()
        ProcessRuntimeRegistry.serviceActive = false
        return publish(PlatformEventKind.STOP_COMPLETED) {
            cleanedFacts(it).copy(activationFailure = null)
        }
    }

    fun revoked(): MobilePlatformFacts {
        clearRecoveryRecord()
        ProcessRuntimeRegistry.serviceActive = false
        return publish(PlatformEventKind.REVOKED) {
            cleanedFacts(it).copy(
                activationFailure = PlatformFailureKind.PERMISSION_REVOKED.wireName,
                vpnPermission = "required",
            )
        }
    }

    fun coreExited(): MobilePlatformFacts {
        clearRecoveryRecord()
        ProcessRuntimeRegistry.serviceActive = false
        return publish(PlatformEventKind.CORE_EXITED) {
            cleanedFacts(it).copy(activationFailure = PlatformFailureKind.CORE_EXITED.wireName)
        }
    }

    fun serviceDestroyed(cleanupSucceeded: Boolean): MobilePlatformFacts {
        if (cleanupSucceeded) clearRecoveryRecord()
        ProcessRuntimeRegistry.serviceActive = false
        return publish(PlatformEventKind.SERVICE_DESTROYED) {
            if (cleanupSucceeded) {
                cleanedFacts(it)
            } else {
                it.copy(
                    activationFailure = PlatformFailureKind.CLEANUP_FAILED.wireName,
                    recoveryEvidence = PlatformRecoveryEvidence.FOREGROUND_EXPECTED.wireName,
                    serviceForeground = false,
                )
            }
        }
    }

    private fun cleanedFacts(facts: MobilePlatformFacts): MobilePlatformFacts = facts.copy(
        activationSessionId = null,
        activeNetwork = false,
        coreRunning = false,
        dnsApplied = false,
        lifecycleAuthority = null,
        protectedSocketCount = 0,
        publicRequestObserved = false,
        recoveryEvidence = PlatformRecoveryEvidence.NONE.wireName,
        routesApplied = false,
        serviceForeground = false,
        tunEstablished = false,
    )

    private fun initialFacts(): MobilePlatformFacts {
        val core = readCoreEvidence()
        val recovery = readRecoveryState()
        return MobilePlatformFacts(
            coreConfigState = core.coreConfigState,
            factSequence = 1,
            loadedConfigDigest = core.loadedConfigDigest,
            loadedConfigRevision = core.loadedConfigRevision,
            lifecycleAuthority = recovery.lifecycleAuthority,
            recoveryEvidence = recovery.evidence.wireName,
            validatedConfigDigest = core.validatedConfigDigest,
            validatedConfigRevision = core.validatedConfigRevision,
        )
    }

    private fun readRecoveryState(): RecoveryState {
        val encoded = preferences.getString(RECOVERY_RECORD, null)
            ?: return RecoveryState(PlatformRecoveryEvidence.NONE, null)
        return runCatching {
            val record = MishVpnRecoveryRecord.fromJson(JSONObject(encoded))
                ?: error("Invalid recovery record")
            RecoveryState(PlatformRecoveryEvidence.FOREGROUND_EXPECTED, record.lifecycleAuthority)
        }.getOrDefault(RecoveryState(PlatformRecoveryEvidence.INVALID, null))
    }

    private fun persistRecoveryRecord(
        serviceInstanceId: String,
        lifecycleAuthority: CoreLifecycleAuthority,
    ) {
        val record = MishVpnRecoveryRecord(serviceInstanceId, lifecycleAuthority)
        check(preferences.edit().putString(RECOVERY_RECORD, record.toJson().toString()).commit()) {
            "Failed to persist the Android platform recovery record."
        }
    }

    private fun clearRecoveryRecord() {
        check(preferences.edit().remove(RECOVERY_RECORD).commit()) {
            "Failed to clear the Android platform recovery record."
        }
    }

    private fun readCoreEvidence(): CoreConfigEvidence {
        val encoded = preferences.getString(CORE_CONFIG_EVIDENCE, null)
            ?: return CoreConfigEvidence()
        return runCatching {
            val value = JSONObject(encoded)
            CoreConfigEvidence(
                coreConfigState = value.optString("coreConfigState", "unloaded")
                    .takeIf { it in setOf("unloaded", "loaded", "unknown") }
                    ?: "unknown",
                loadedConfigDigest = value.optStringOrNull("loadedConfigDigest"),
                loadedConfigRevision = value.optStringOrNull("loadedConfigRevision"),
                validatedConfigDigest = value.optStringOrNull("validatedConfigDigest"),
                validatedConfigRevision = value.optStringOrNull("validatedConfigRevision"),
            ).normalized()
        }.getOrElse { CoreConfigEvidence(coreConfigState = "unknown") }
    }

    private fun persistCoreEvidence(next: MobilePlatformFacts) {
        val evidence = CoreConfigEvidence(
            coreConfigState = next.coreConfigState,
            loadedConfigDigest = next.loadedConfigDigest,
            loadedConfigRevision = next.loadedConfigRevision,
            validatedConfigDigest = next.validatedConfigDigest,
            validatedConfigRevision = next.validatedConfigRevision,
        ).normalized()
        val encoded = JSONObject()
            .put("coreConfigState", evidence.coreConfigState)
            .put("loadedConfigDigest", evidence.loadedConfigDigest)
            .put("loadedConfigRevision", evidence.loadedConfigRevision)
            .put("validatedConfigDigest", evidence.validatedConfigDigest)
            .put("validatedConfigRevision", evidence.validatedConfigRevision)
        check(preferences.edit().putString(CORE_CONFIG_EVIDENCE, encoded.toString()).commit()) {
            "Failed to persist bounded Mobile Core configuration evidence."
        }
    }

    private fun broadcast(facts: MobilePlatformFacts) {
        val intent = Intent(ACTION_FACTS_CHANGED)
            .setPackage(applicationContext.packageName)
            .putExtra(EXTRA_FACTS, facts.toJson().toString())
        applicationContext.sendBroadcast(intent)
    }

    companion object {
        const val ACTION_FACTS_CHANGED = "com.asuka109.mish.vpn.FACTS_CHANGED"
        const val EXTRA_FACTS = "facts"
        private const val CORE_CONFIG_EVIDENCE = "core-config-evidence-v1"
        private const val LEGACY_PRODUCT_SNAPSHOT = "snapshot-v1"
        private const val PREFERENCES = "mish-vpn-phase0"
        private const val RECOVERY_RECORD = "platform-recovery-v1"
        private val IDENTIFIER_PATTERN = Regex("^[A-Za-z0-9._-]{1,128}$")
        private val lock = Any()
    }
}

private data class RecoveryState(
    val evidence: PlatformRecoveryEvidence,
    val lifecycleAuthority: CoreLifecycleAuthority?,
)

/** Minimal durable evidence needed to recover and retire owned Android state. */
internal data class MishVpnRecoveryRecord(
    val serviceInstanceId: String,
    val lifecycleAuthority: CoreLifecycleAuthority,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("foregroundExpected", true)
        .put("lifecycleAuthority", lifecycleAuthority.toJson())
        .put("schemaVersion", SCHEMA_VERSION)
        .put("serviceInstanceId", serviceInstanceId)

    companion object {
        private const val SCHEMA_VERSION = 2
        private val IDENTIFIER_PATTERN = Regex("^[A-Za-z0-9._-]{1,128}$")

        fun fromJson(value: JSONObject): MishVpnRecoveryRecord? = runCatching {
            check(value.length() == 4)
            check(value.getInt("schemaVersion") == SCHEMA_VERSION)
            check(value.getBoolean("foregroundExpected"))
            val serviceInstanceId = value.getString("serviceInstanceId")
            check(serviceInstanceId.matches(IDENTIFIER_PATTERN))
            val authority = CoreLifecycleAuthority.fromJson(
                value.getJSONObject("lifecycleAuthority"),
            ) ?: error("Invalid lifecycle authority")
            MishVpnRecoveryRecord(serviceInstanceId, authority)
        }.getOrNull()
    }
}

private data class CoreConfigEvidence(
    val coreConfigState: String = "unloaded",
    val loadedConfigDigest: String? = null,
    val loadedConfigRevision: String? = null,
    val validatedConfigDigest: String? = null,
    val validatedConfigRevision: String? = null,
) {
    fun normalized(): CoreConfigEvidence {
        val loadedComplete = loadedConfigDigest != null && loadedConfigRevision != null
        val validatedComplete = validatedConfigDigest != null && validatedConfigRevision != null
        return copy(
            coreConfigState = when {
                coreConfigState == "loaded" && loadedComplete -> "loaded"
                coreConfigState == "loaded" -> "unknown"
                coreConfigState in setOf("unloaded", "unknown") -> coreConfigState
                else -> "unknown"
            },
            loadedConfigDigest = loadedConfigDigest.takeIf { coreConfigState == "loaded" && loadedComplete },
            loadedConfigRevision = loadedConfigRevision.takeIf { coreConfigState == "loaded" && loadedComplete },
            validatedConfigDigest = validatedConfigDigest.takeIf { validatedComplete },
            validatedConfigRevision = validatedConfigRevision.takeIf { validatedComplete },
        )
    }
}

internal fun reconcileCoreConfigFacts(
    current: MobilePlatformFacts,
    inspection: NativeConfigInspectionResult,
): MobilePlatformFacts {
    val nextState = when (inspection.code) {
        NativeInspectionCode.LOADED_EXPECTED -> "loaded"
        NativeInspectionCode.UNLOADED -> "unloaded"
        NativeInspectionCode.LOADED_OTHER,
        NativeInspectionCode.MALFORMED_RESPONSE,
        NativeInspectionCode.RESPONSE_TOO_LARGE,
        NativeInspectionCode.NATIVE_FAILED,
        -> "unknown"
    }
    return current.copy(
        coreConfigState = nextState,
        loadedConfigDigest = if (nextState == "loaded") current.loadedConfigDigest else null,
        loadedConfigRevision = if (nextState == "loaded") current.loadedConfigRevision else null,
    )
}
