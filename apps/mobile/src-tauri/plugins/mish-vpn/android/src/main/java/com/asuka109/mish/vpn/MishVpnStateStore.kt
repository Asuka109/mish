package com.asuka109.mish.vpn

import android.content.Context
import android.content.Intent
import org.json.JSONObject

internal interface SnapshotRepository {
    fun current(): MobileVpnSnapshot
    fun update(transform: (MobileVpnSnapshot) -> MobileVpnSnapshot): MobileVpnSnapshot
}

internal object ProcessRuntimeRegistry {
    @Volatile
    var serviceActive = false
}

internal class MishVpnStateStore(context: Context) : SnapshotRepository {
    private val applicationContext = context.applicationContext
    private val preferences = applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override fun current(): MobileVpnSnapshot = synchronized(lock) {
        readSnapshot()
    }

    override fun update(transform: (MobileVpnSnapshot) -> MobileVpnSnapshot): MobileVpnSnapshot =
        synchronized(lock) {
            val current = readSnapshot()
            val transformed = transform(current)
            val next = transformed.copy(
                backendKind = "fixture",
                contractVersion = CONTRACT_VERSION,
                coreAvailability = "unavailable",
                sequence = current.sequence + 1,
                updatedAtMillis = System.currentTimeMillis(),
                vpnActive = transformed.vpnActive && transformed.phase == VpnPhase.RUNNING.wireName,
            )
            check(next.message.length <= MAX_MESSAGE_LENGTH)
            check(preferences.edit().putString(SNAPSHOT, next.toJson().toString()).commit()) {
                "Failed to persist the authoritative Android VPN lifecycle snapshot."
            }
            publish(next)
            next
        }

    fun recoverAfterProcessStart(): MobileVpnSnapshot {
        val snapshot = current()
        if (!snapshot.foreground && snapshot.phase !in ACTIVE_OR_TRANSITIONAL_PHASES) return snapshot
        return update {
            it.copy(
                foreground = false,
                message = "Previous lifecycle outcome is unknown after process recovery. Retry explicitly.",
                phase = VpnPhase.RECOVERY_REQUIRED.wireName,
                vpnActive = false,
            )
        }
    }

    private fun readSnapshot(): MobileVpnSnapshot {
        val encoded = preferences.getString(SNAPSHOT, null) ?: return MobileVpnSnapshot()
        return runCatching { MobileVpnSnapshot.fromJson(JSONObject(encoded)) }
            .getOrElse { MobileVpnSnapshot(message = "Stored lifecycle state was invalid and was reset safely.") }
    }

    private fun publish(snapshot: MobileVpnSnapshot) {
        val event = MobileVpnEvent(
            sequence = snapshot.sequence,
            sessionId = snapshot.sessionId,
            snapshot = snapshot,
        )
        val intent = Intent(ACTION_SNAPSHOT_CHANGED)
            .setPackage(applicationContext.packageName)
            .putExtra(EXTRA_EVENT, event.toJson().toString())
        applicationContext.sendBroadcast(intent)
    }

    companion object {
        const val ACTION_SNAPSHOT_CHANGED = "com.asuka109.mish.vpn.SNAPSHOT_CHANGED"
        const val EXTRA_EVENT = "event"
        private const val MAX_MESSAGE_LENGTH = 512
        private const val PREFERENCES = "mish-vpn-phase0"
        private const val SNAPSHOT = "snapshot-v1"
        private val lock = Any()
        private val ACTIVE_OR_TRANSITIONAL_PHASES = setOf(
            VpnPhase.STARTING.wireName,
            VpnPhase.RUNNING.wireName,
            VpnPhase.STOPPING.wireName,
        )
    }
}
