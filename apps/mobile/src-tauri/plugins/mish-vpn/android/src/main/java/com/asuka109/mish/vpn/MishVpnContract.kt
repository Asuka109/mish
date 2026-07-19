package com.asuka109.mish.vpn

import org.json.JSONObject
import java.util.UUID

internal const val CONTRACT_VERSION = 1

internal enum class VpnPhase(val wireName: String) {
    STOPPED("stopped"),
    PERMISSION_REQUIRED("permission-required"),
    STARTING("starting"),
    RUNNING("running"),
    STOPPING("stopping"),
    FAILED("failed"),
    RECOVERY_REQUIRED("recovery-required"),
    UNAVAILABLE("unavailable"),
}

internal data class MobileVpnSnapshot(
    val backendKind: String = "fixture",
    val contractVersion: Int = CONTRACT_VERSION,
    val coreAvailability: String = "unavailable",
    val foreground: Boolean = false,
    val message: String = "Android VPN lifecycle fixture ready. No TUN or Core is available.",
    val notificationPermission: String = "not-required",
    val permission: String = "unknown",
    val phase: String = VpnPhase.STOPPED.wireName,
    val sequence: Long = 0,
    val sessionId: String = UUID.randomUUID().toString(),
    val updatedAtMillis: Long = System.currentTimeMillis(),
    val vpnActive: Boolean = false,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("backendKind", backendKind)
        .put("contractVersion", contractVersion)
        .put("coreAvailability", coreAvailability)
        .put("foreground", foreground)
        .put("message", message)
        .put("notificationPermission", notificationPermission)
        .put("permission", permission)
        .put("phase", phase)
        .put("sequence", sequence)
        .put("sessionId", sessionId)
        .put("updatedAtMillis", updatedAtMillis)
        .put("vpnActive", vpnActive)

    companion object {
        fun fromJson(value: JSONObject): MobileVpnSnapshot = MobileVpnSnapshot(
            backendKind = value.optString("backendKind", "fixture"),
            contractVersion = value.optInt("contractVersion", CONTRACT_VERSION),
            coreAvailability = value.optString("coreAvailability", "unavailable"),
            foreground = value.optBoolean("foreground", false),
            message = value.optString(
                "message",
                "Android VPN lifecycle fixture ready. No TUN or Core is available.",
            ),
            notificationPermission = value.optString("notificationPermission", "not-required"),
            permission = value.optString("permission", "unknown"),
            phase = value.optString("phase", VpnPhase.STOPPED.wireName),
            sequence = value.optLong("sequence", 0),
            sessionId = value.optString("sessionId").ifBlank { UUID.randomUUID().toString() },
            updatedAtMillis = value.optLong("updatedAtMillis", System.currentTimeMillis()),
            vpnActive = value.optBoolean("vpnActive", false),
        )
    }
}

internal data class MobileVpnEvent(
    val eventKind: String = "snapshot-changed",
    val eventVersion: Int = 1,
    val sequence: Long,
    val sessionId: String,
    val snapshot: MobileVpnSnapshot,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("eventKind", eventKind)
        .put("eventVersion", eventVersion)
        .put("sequence", sequence)
        .put("sessionId", sessionId)
        .put("snapshot", snapshot.toJson())
}
