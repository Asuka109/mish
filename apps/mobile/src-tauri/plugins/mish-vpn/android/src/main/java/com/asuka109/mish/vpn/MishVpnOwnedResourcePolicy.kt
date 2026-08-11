package com.asuka109.mish.vpn

/**
 * The cleanup barrier is deliberately per-resource rather than one cached
 * boolean. A failed callback keeps that resource owned and can be retried by a
 * later stop/recreation attempt; resources that already released are not
 * invoked again.
 */
internal enum class MishVpnCleanupState {
    PENDING,
    RETRYABLE,
    COMPLETE,
}

internal data class MishVpnOwnedRecoveryState(
    val cleanupState: MishVpnCleanupState,
    val coreOwned: Boolean,
    val tunOwned: Boolean,
    val networkOwned: Boolean,
) {
    val retryable: Boolean
        get() = cleanupState == MishVpnCleanupState.RETRYABLE
}

internal class MishVpnOwnedResourceCleanup {
    private var coreReleased = false
    private var tunReleased = false
    private var networkReleased = false
    private var attempted = false

    @Synchronized
    fun recoveryState(): MishVpnOwnedRecoveryState = MishVpnOwnedRecoveryState(
        cleanupState = when {
            coreReleased && tunReleased && networkReleased -> MishVpnCleanupState.COMPLETE
            attempted -> MishVpnCleanupState.RETRYABLE
            else -> MishVpnCleanupState.PENDING
        },
        coreOwned = !coreReleased,
        tunOwned = !tunReleased,
        networkOwned = !networkReleased,
    )

    @Synchronized
    fun isComplete(): Boolean = coreReleased && tunReleased && networkReleased

    @Synchronized
    fun cleanup(
        stopCore: () -> Boolean,
        closeTun: () -> Boolean,
        unregisterNetwork: () -> Boolean,
    ): Boolean {
        if (!coreReleased) coreReleased = runCatching(stopCore).getOrDefault(false)
        if (!tunReleased) tunReleased = runCatching(closeTun).getOrDefault(false)
        if (!networkReleased) {
            networkReleased = runCatching(unregisterNetwork).getOrDefault(false)
        }
        attempted = true
        return isComplete()
    }
}

internal class ProtectedSocketFactGate {
    private var observed = false

    @Synchronized
    fun record(protected: Boolean, publish: () -> Unit): Boolean {
        if (protected && !observed) {
            observed = true
            publish()
        }
        return protected
    }

    @Synchronized
    fun reset() {
        observed = false
    }
}
