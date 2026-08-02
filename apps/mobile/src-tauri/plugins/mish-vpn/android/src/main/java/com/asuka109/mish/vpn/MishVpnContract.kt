package com.asuka109.mish.vpn

import org.json.JSONObject
import java.util.UUID

internal const val CONTRACT_VERSION = 1

internal enum class PlatformEventKind(val wireName: String) {
    OBSERVATION("observation"),
    CONSENT_RESULT("consent-result"),
    NOTIFICATION_RESULT("notification-result"),
    START_COMPLETED("start-completed"),
    STOP_COMPLETED("stop-completed"),
    REVOKED("revoked"),
    SERVICE_DESTROYED("service-destroyed"),
}

internal enum class PlatformRecoveryEvidence(val wireName: String) {
    NONE("none"),
    FOREGROUND_EXPECTED("foreground-expected"),
    INVALID("invalid"),
}

internal data class MobilePlatformFacts(
    val configFailureInjectionAvailable: Boolean = false,
    val coreAbiVersion: Int? = null,
    val coreAvailability: String = "unavailable",
    val coreCommit: String? = null,
    val coreConfigState: String = "unloaded",
    val coreVersion: String? = null,
    val coreWrapperRevision: String? = null,
    val event: String = PlatformEventKind.OBSERVATION.wireName,
    val factSequence: Long = 0,
    val loadedConfigDigest: String? = null,
    val loadedConfigRevision: String? = null,
    val notificationPermission: String = "not-required",
    val observedAtMillis: Long = System.currentTimeMillis(),
    val platformSessionId: String = UUID.randomUUID().toString(),
    val recoveryEvidence: String = PlatformRecoveryEvidence.NONE.wireName,
    val serviceForeground: Boolean = false,
    val validatedConfigDigest: String? = null,
    val validatedConfigRevision: String? = null,
    val vpnPermission: String = "unknown",
) {
    fun toJson(): JSONObject = JSONObject()
        .put("configFailureInjectionAvailable", configFailureInjectionAvailable)
        .put("coreAbiVersion", coreAbiVersion)
        .put("coreAvailability", coreAvailability)
        .put("coreCommit", coreCommit)
        .put("coreConfigState", coreConfigState)
        .put("coreVersion", coreVersion)
        .put("coreWrapperRevision", coreWrapperRevision)
        .put("event", event)
        .put("factSequence", factSequence)
        .put("loadedConfigDigest", loadedConfigDigest)
        .put("loadedConfigRevision", loadedConfigRevision)
        .put("notificationPermission", notificationPermission)
        .put("observedAtMillis", observedAtMillis)
        .put("platformSessionId", platformSessionId)
        .put("recoveryEvidence", recoveryEvidence)
        .put("serviceForeground", serviceForeground)
        .put("validatedConfigDigest", validatedConfigDigest)
        .put("validatedConfigRevision", validatedConfigRevision)
        .put("vpnPermission", vpnPermission)
}

internal fun JSONObject.optIntOrNull(name: String): Int? =
    if (isNull(name)) null else optInt(name).takeIf { it > 0 }

internal fun JSONObject.optStringOrNull(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
