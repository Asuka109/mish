package com.asuka109.mish.vpn

import java.util.UUID

internal class MishVpnStateMachine(
    private val repository: SnapshotRepository,
    private val backend: VpnBackend,
) {
    @Synchronized
    fun start(permissionGranted: Boolean): MobileVpnSnapshot {
        val current = repository.current()
        if (!permissionGranted) {
            backend.stop()
            return repository.update {
                it.copy(
                    foreground = false,
                    message = "Android VPN permission is required before the service can start.",
                    permission = "required",
                    phase = VpnPhase.PERMISSION_REQUIRED.wireName,
                    vpnActive = false,
                )
            }
        }
        if (
            current.foreground ||
            current.phase == VpnPhase.STARTING.wireName ||
            current.phase == VpnPhase.RUNNING.wireName
        ) {
            return current
        }

        val starting = repository.update {
            it.copy(
                foreground = true,
                message = "Checking the Android VPN lifecycle fixture. No traffic is captured.",
                permission = "granted",
                phase = VpnPhase.STARTING.wireName,
                sessionId = UUID.randomUUID().toString(),
                vpnActive = false,
            )
        }
        return when (val result = backend.start()) {
            BackendStartResult.Started -> repository.update {
                starting.copy(
                    foreground = true,
                    message = "A replaceable native backend is running.",
                    phase = VpnPhase.RUNNING.wireName,
                    vpnActive = true,
                )
            }
            is BackendStartResult.Failed -> repository.update {
                starting.copy(
                    foreground = false,
                    message = result.message,
                    phase = VpnPhase.FAILED.wireName,
                    vpnActive = false,
                )
            }
            is BackendStartResult.Unavailable -> repository.update {
                starting.copy(
                    foreground = true,
                    message = result.message,
                    phase = VpnPhase.UNAVAILABLE.wireName,
                    vpnActive = false,
                )
            }
        }
    }

    @Synchronized
    fun stop(message: String = "Android VPN lifecycle stopped safely."): MobileVpnSnapshot {
        val current = repository.current()
        if (current.phase == VpnPhase.STOPPED.wireName) return current
        repository.update {
            it.copy(
                message = "Stopping the Android VPN lifecycle.",
                phase = VpnPhase.STOPPING.wireName,
                vpnActive = false,
            )
        }
        backend.stop()
        return repository.update {
            it.copy(
                foreground = false,
                message = message,
                phase = VpnPhase.STOPPED.wireName,
                vpnActive = false,
            )
        }
    }

    @Synchronized
    fun revoked(): MobileVpnSnapshot {
        backend.stop()
        return repository.update {
            it.copy(
                foreground = false,
                message = "Android revoked VPN permission. Native resources were closed conservatively.",
                permission = "required",
                phase = VpnPhase.PERMISSION_REQUIRED.wireName,
                vpnActive = false,
            )
        }
    }

    @Synchronized
    fun serviceDestroyed(): MobileVpnSnapshot {
        val current = repository.current()
        if (!current.foreground && current.phase !in ACTIVE_OR_TRANSITIONAL_PHASES) return current
        backend.stop()
        return repository.update {
            it.copy(
                foreground = false,
                message = "The service was destroyed with an unknown outcome. Retry explicitly.",
                phase = VpnPhase.RECOVERY_REQUIRED.wireName,
                vpnActive = false,
            )
        }
    }

    private companion object {
        val ACTIVE_OR_TRANSITIONAL_PHASES = setOf(
            VpnPhase.STARTING.wireName,
            VpnPhase.RUNNING.wireName,
            VpnPhase.STOPPING.wireName,
        )
    }
}
