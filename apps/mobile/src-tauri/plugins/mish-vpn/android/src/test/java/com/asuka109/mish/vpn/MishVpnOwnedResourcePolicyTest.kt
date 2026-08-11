package com.asuka109.mish.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MishVpnOwnedResourcePolicyTest {
    @Test
    fun `cleanup is ordered complete and idempotent`() {
        val calls = mutableListOf<String>()
        val cleanup = MishVpnOwnedResourceCleanup()

        assertTrue(
            cleanup.cleanup(
                stopCore = { calls += "core"; true },
                closeTun = { calls += "tun"; true },
                unregisterNetwork = { calls += "network"; true },
            ),
        )
        assertTrue(cleanup.cleanup({ false }, { false }, { false }))
        assertEquals(listOf("core", "tun", "network"), calls)
    }

    @Test
    fun `cleanup attempts every owned resource and retains failure`() {
        val calls = mutableListOf<String>()
        val cleanup = MishVpnOwnedResourceCleanup()

        assertFalse(
            cleanup.cleanup(
                stopCore = { calls += "core"; false },
                closeTun = { calls += "tun"; true },
                unregisterNetwork = { calls += "network"; true },
            ),
        )
        assertEquals(MishVpnCleanupState.RETRYABLE, cleanup.recoveryState().cleanupState)
        assertTrue(cleanup.recoveryState().retryable)
        assertTrue(cleanup.recoveryState().coreOwned)
        assertEquals(listOf("core", "tun", "network"), calls)
    }

    @Test
    fun `cleanup retries only failed resources and publishes clean only after all succeed`() {
        var coreAttempts = 0
        var tunAttempts = 0
        var networkAttempts = 0
        var coreCanStop = false
        val cleanup = MishVpnOwnedResourceCleanup()

        assertFalse(
            cleanup.cleanup(
                stopCore = { coreAttempts += 1; coreCanStop },
                closeTun = { tunAttempts += 1; true },
                unregisterNetwork = { networkAttempts += 1; true },
            ),
        )
        assertEquals(MishVpnCleanupState.RETRYABLE, cleanup.recoveryState().cleanupState)
        assertTrue(cleanup.recoveryState().coreOwned)
        assertFalse(cleanup.recoveryState().tunOwned)
        assertFalse(cleanup.recoveryState().networkOwned)

        coreCanStop = true
        assertTrue(
            cleanup.cleanup(
                stopCore = { coreAttempts += 1; coreCanStop },
                closeTun = { tunAttempts += 1; false },
                unregisterNetwork = { networkAttempts += 1; false },
            ),
        )
        assertEquals(MishVpnCleanupState.COMPLETE, cleanup.recoveryState().cleanupState)
        assertEquals(2, coreAttempts)
        assertEquals(1, tunAttempts)
        assertEquals(1, networkAttempts)

        assertTrue(cleanup.cleanup({ coreAttempts += 1; false }, { false }, { false }))
        assertEquals(2, coreAttempts)
    }

    @Test
    fun `protected socket evidence publishes once and only after success`() {
        val gate = ProtectedSocketFactGate()
        var publications = 0

        assertFalse(gate.record(false) { publications += 1 })
        assertTrue(gate.record(true) { publications += 1 })
        assertTrue(gate.record(true) { publications += 1 })
        assertEquals(1, publications)
    }
}
