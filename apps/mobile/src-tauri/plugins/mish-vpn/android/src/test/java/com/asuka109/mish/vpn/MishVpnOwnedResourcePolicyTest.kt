package com.asuka109.mish.vpn

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
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
        assertFalse(cleanup.cleanup({ true }, { true }, { true }))
        assertEquals(listOf("core", "tun", "network"), calls)
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
