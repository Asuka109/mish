package com.asuka109.mish.vpn

internal class MishVpnOwnedResourceCleanup {
    private var completed: Boolean? = null

    @Synchronized
    fun cleanup(
        stopCore: () -> Boolean,
        closeTun: () -> Boolean,
        unregisterNetwork: () -> Boolean,
    ): Boolean {
        completed?.let { return it }
        val coreStopped = stopCore()
        val tunClosed = closeTun()
        val networkReleased = unregisterNetwork()
        return (coreStopped && tunClosed && networkReleased).also { completed = it }
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
