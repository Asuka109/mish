package com.asuka109.mish.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MishVpnStateMachineTest {
    @Test
    fun `fixture start remains unavailable and never claims vpn or core`() {
        val repository = MemorySnapshotRepository()
        val machine = MishVpnStateMachine(repository, FixtureVpnBackend())

        val snapshot = machine.start(permissionGranted = true)

        assertEquals(VpnPhase.UNAVAILABLE.wireName, snapshot.phase)
        assertEquals("fixture", snapshot.backendKind)
        assertEquals("unavailable", snapshot.coreAvailability)
        assertFalse(snapshot.vpnActive)
        assertTrue(snapshot.foreground)
        assertTrue(snapshot.message.contains("without creating a TUN"))
    }

    @Test
    fun `start without consent remains permission required and closes backend`() {
        val repository = MemorySnapshotRepository()
        val backend = RecordingBackend(BackendStartResult.Started)
        val machine = MishVpnStateMachine(repository, backend)

        val snapshot = machine.start(permissionGranted = false)

        assertEquals(VpnPhase.PERMISSION_REQUIRED.wireName, snapshot.phase)
        assertEquals("required", snapshot.permission)
        assertEquals(0, backend.startCount)
        assertEquals(1, backend.stopCount)
        assertFalse(snapshot.vpnActive)
    }

    @Test
    fun `commands are serialized and duplicate running start is idempotent`() {
        val repository = MemorySnapshotRepository()
        val backend = RecordingBackend(BackendStartResult.Started)
        val machine = MishVpnStateMachine(repository, backend)

        val running = machine.start(permissionGranted = true)
        val duplicate = machine.start(permissionGranted = true)

        assertEquals(VpnPhase.RUNNING.wireName, running.phase)
        assertTrue(running.vpnActive)
        assertEquals(running, duplicate)
        assertEquals(1, backend.startCount)
    }

    @Test
    fun `explicit stop is conservative and idempotent`() {
        val repository = MemorySnapshotRepository()
        val backend = RecordingBackend(BackendStartResult.Started)
        val machine = MishVpnStateMachine(repository, backend)
        val running = machine.start(permissionGranted = true)

        val stopped = machine.stop()
        val duplicate = machine.stop()

        assertEquals(VpnPhase.STOPPED.wireName, stopped.phase)
        assertFalse(stopped.vpnActive)
        assertFalse(stopped.foreground)
        assertNotEquals(running.sequence, stopped.sequence)
        assertEquals(stopped, duplicate)
        assertEquals(1, backend.stopCount)
    }

    @Test
    fun `fixture lifecycle remains idempotent while its honest notification is foreground`() {
        val repository = MemorySnapshotRepository()
        val backend = FixtureVpnBackend()
        val machine = MishVpnStateMachine(repository, backend)

        val unavailable = machine.start(permissionGranted = true)
        val duplicate = machine.start(permissionGranted = true)

        assertEquals(VpnPhase.UNAVAILABLE.wireName, unavailable.phase)
        assertTrue(unavailable.foreground)
        assertFalse(unavailable.vpnActive)
        assertEquals(unavailable, duplicate)
    }

    @Test
    fun `destroyed running service requires explicit recovery`() {
        val repository = MemorySnapshotRepository()
        val backend = RecordingBackend(BackendStartResult.Started)
        val machine = MishVpnStateMachine(repository, backend)
        machine.start(permissionGranted = true)

        val recovered = machine.serviceDestroyed()

        assertEquals(VpnPhase.RECOVERY_REQUIRED.wireName, recovered.phase)
        assertFalse(recovered.vpnActive)
        assertFalse(recovered.foreground)
        assertEquals(1, backend.stopCount)
    }
}

private class MemorySnapshotRepository : SnapshotRepository {
    private var snapshot = MobileVpnSnapshot()

    override fun current(): MobileVpnSnapshot = snapshot

    override fun update(transform: (MobileVpnSnapshot) -> MobileVpnSnapshot): MobileVpnSnapshot {
        snapshot = transform(snapshot).copy(
            backendKind = "fixture",
            contractVersion = CONTRACT_VERSION,
            coreAvailability = "unavailable",
            sequence = snapshot.sequence + 1,
            updatedAtMillis = snapshot.updatedAtMillis + 1,
        )
        return snapshot
    }
}

private class RecordingBackend(
    private val result: BackendStartResult,
) : VpnBackend {
    var startCount = 0
    var stopCount = 0

    override fun start(): BackendStartResult {
        startCount += 1
        return result
    }

    override fun stop() {
        stopCount += 1
    }
}
