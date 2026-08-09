package com.asuka109.mish.vpn

import org.json.JSONObject
import java.util.UUID
import app.tauri.annotation.InvokeArg

internal const val CONTRACT_VERSION = 1

internal data class MobilePlatformFacts(
    val activationFailure: String? = null,
    val activationSessionId: String? = null,
    val activeNetwork: Boolean = false,
    val configFailureInjectionAvailable: Boolean = false,
    val coreAbiVersion: Int? = null,
    val coreAvailability: String = "unavailable",
    val coreCommit: String? = null,
    val coreConfigState: String = "unloaded",
    val coreRunning: Boolean = false,
    val coreVersion: String? = null,
    val coreWrapperRevision: String? = null,
    val event: String = PlatformEventKind.OBSERVATION.wireName,
    val factSequence: Long = 0,
    val factsVersion: Int = ANDROID_PLATFORM_FACTS_VERSION,
    val loadedConfigDigest: String? = null,
    val loadedConfigRevision: String? = null,
    val lifecycleAuthority: CoreLifecycleAuthority? = null,
    val notificationPermission: String = "not-required",
    val observedAtMillis: Long = System.currentTimeMillis(),
    val platformSessionId: String = UUID.randomUUID().toString(),
    val protectedSocketCount: Long = 0,
    val publicRequestObserved: Boolean = false,
    val recoveryEvidence: String = PlatformRecoveryEvidence.NONE.wireName,
    val routesApplied: Boolean = false,
    val serviceForeground: Boolean = false,
    val dnsApplied: Boolean = false,
    val tunEstablished: Boolean = false,
    val validatedConfigDigest: String? = null,
    val validatedConfigRevision: String? = null,
    val vpnPermission: String = "unknown",
) {
    fun toJson(): JSONObject = platformFactsToJson(this)
}

@InvokeArg
internal class StartLifecycleArgs {
    var configDigest: String = ""
    var configRevision: String = ""
    var factSequence: Long = -1
    var platformSessionId: String = ""
    var productSessionId: String = ""
    var machineAuthority: String = ""
    var scopeEpoch: Long = -1
    var operationId: String = ""
    var admittedRevision: Long = -1
    var effectIdentity: String = ""
}

@InvokeArg
internal class StopLifecycleArgs {
    var machineAuthority: String = ""
    var scopeEpoch: Long = -1
    var operationId: String = ""
    var admittedRevision: Long = -1
    var effectIdentity: String = ""
}

internal fun JSONObject.optIntOrNull(name: String): Int? =
    if (isNull(name)) null else optInt(name).takeIf { it > 0 }

internal fun JSONObject.optStringOrNull(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
