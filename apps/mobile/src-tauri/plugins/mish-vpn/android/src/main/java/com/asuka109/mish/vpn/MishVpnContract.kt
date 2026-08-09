package com.asuka109.mish.vpn

import org.json.JSONObject
import java.util.UUID
import app.tauri.annotation.InvokeArg

internal const val CONTRACT_VERSION = 1

internal enum class PlatformEventKind(val wireName: String) {
    OBSERVATION("observation"),
    CONSENT_RESULT("consent-result"),
    NOTIFICATION_RESULT("notification-result"),
    ACTIVATION_PROGRESS("activation-progress"),
    ACTIVATION_COMPLETED("activation-completed"),
    ACTIVATION_FAILED("activation-failed"),
    STOP_COMPLETED("stop-completed"),
    NETWORK_CHANGED("network-changed"),
    CORE_EXITED("core-exited"),
    REVOKED("revoked"),
    SERVICE_DESTROYED("service-destroyed"),
}

internal enum class PlatformFailureKind(val wireName: String) {
    CLEANUP_FAILED("cleanup-failed"),
    CONFIGURATION_NOT_LOADED("configuration-not-loaded"),
    CORE_EXITED("core-exited"),
    CORE_START_FAILED("core-start-failed"),
    CORE_UNAVAILABLE("core-unavailable"),
    NETWORK_UNAVAILABLE("network-unavailable"),
    PERMISSION_REVOKED("permission-revoked"),
    PUBLIC_REQUEST_FAILED("public-request-failed"),
    TUN_ESTABLISH_FAILED("tun-establish-failed"),
}

internal enum class PlatformRecoveryEvidence(val wireName: String) {
    NONE("none"),
    FOREGROUND_EXPECTED("foreground-expected"),
    INVALID("invalid"),
}

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
    fun toJson(): JSONObject = JSONObject()
        .put("activationFailure", activationFailure)
        .put("activationSessionId", activationSessionId)
        .put("activeNetwork", activeNetwork)
        .put("configFailureInjectionAvailable", configFailureInjectionAvailable)
        .put("coreAbiVersion", coreAbiVersion)
        .put("coreAvailability", coreAvailability)
        .put("coreCommit", coreCommit)
        .put("coreConfigState", coreConfigState)
        .put("coreRunning", coreRunning)
        .put("coreVersion", coreVersion)
        .put("coreWrapperRevision", coreWrapperRevision)
        .put("event", event)
        .put("factSequence", factSequence)
        .put("loadedConfigDigest", loadedConfigDigest)
        .put("loadedConfigRevision", loadedConfigRevision)
        .put("lifecycleAuthority", lifecycleAuthority?.toJson())
        .put("notificationPermission", notificationPermission)
        .put("observedAtMillis", observedAtMillis)
        .put("platformSessionId", platformSessionId)
        .put("protectedSocketCount", protectedSocketCount)
        .put("publicRequestObserved", publicRequestObserved)
        .put("recoveryEvidence", recoveryEvidence)
        .put("routesApplied", routesApplied)
        .put("serviceForeground", serviceForeground)
        .put("dnsApplied", dnsApplied)
        .put("tunEstablished", tunEstablished)
        .put("validatedConfigDigest", validatedConfigDigest)
        .put("validatedConfigRevision", validatedConfigRevision)
        .put("vpnPermission", vpnPermission)
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
