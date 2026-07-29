package com.asuka109.mish.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MishMobileCoreLoadTest {
    @Test
    fun `first load validates the exact revision before native loading`() {
        val repository = LoadRepository()
        val calls = mutableListOf<String>()
        val coordinator = MobileConfigLoadCoordinator(
            repository,
            validator = FakeValidator(calls),
            loader = FakeLoader(calls),
        )

        val result = coordinator.load(args(repository.current(), CONFIG_A, "revision-a"))

        assertEquals(listOf("validate", "load"), calls)
        assertEquals("first-load", result.outcome)
        assertNull(result.failure)
        assertEquals("loaded", result.snapshot.coreConfigState)
        assertEquals("revision-a", result.snapshot.loadedConfigRevision)
        assertFalse(result.snapshot.vpnActive)
        assertEquals("unavailable", result.snapshot.vpnAvailability)
        assertEquals("unavailable", result.snapshot.tunAvailability)
    }

    @Test
    fun `replacement duplicate and rollback preserve authoritative loaded identity`() {
        val repository = LoadRepository()
        val validator = FakeValidator()
        val loader = SequencedLoader(
            NativeConfigLoadResult(NativeLoadCode.LOADED, 0),
            NativeConfigLoadResult(NativeLoadCode.LOADED, 0),
            NativeConfigLoadResult(NativeLoadCode.NATIVE_FAILED, 8, rollbackGuaranteed = true),
        )
        val coordinator = MobileConfigLoadCoordinator(repository, validator, loader)

        val first = coordinator.load(args(repository.current(), CONFIG_A, "revision-a"))
        val duplicate = coordinator.load(args(repository.current(), CONFIG_A, "revision-a"))
        val replaced = coordinator.load(args(repository.current(), CONFIG_B, "revision-b"))
        val rejected = coordinator.load(args(repository.current(), CONFIG_C, "revision-c"))

        assertEquals("first-load", first.outcome)
        assertEquals("no-op", duplicate.outcome)
        assertEquals("replacement", replaced.outcome)
        assertEquals("failed", rejected.outcome)
        assertEquals("preserved", rejected.rollback)
        assertEquals("revision-b", rejected.snapshot.loadedConfigRevision)
        assertEquals(3, loader.calls.get())
    }

    @Test
    fun `invalid input is rejected before validation and malformed replacement becomes unknown`() {
        val repository = LoadRepository()
        val validationCalls = AtomicInteger()
        val validator = FakeValidator(counter = validationCalls)
        val loader = SequencedLoader(
            NativeConfigLoadResult(NativeLoadCode.LOADED, 0),
            NativeConfigLoadResult(NativeLoadCode.MALFORMED_RESPONSE, 0),
        )
        val coordinator = MobileConfigLoadCoordinator(repository, validator, loader)
        val invalid = args(repository.current(), CONFIG_A, "revision-a").apply {
            digest = "0".repeat(64)
        }

        val rejected = coordinator.load(invalid)
        assertEquals(0, validationCalls.get())
        val first = coordinator.load(args(repository.current(), CONFIG_A, "revision-a"))
        val malformed = coordinator.load(args(repository.current(), CONFIG_B, "revision-b"))

        assertEquals("digest-mismatch", rejected.failure)
        assertEquals("first-load", first.outcome)
        assertEquals("malformed-native-response", malformed.failure)
        assertEquals("unknown", malformed.rollback)
        assertEquals("unknown", malformed.snapshot.coreConfigState)
        assertNull(malformed.snapshot.loadedConfigDigest)
    }

    @Test
    fun `cancellation is ordered before or after the native load barrier`() {
        val repository = LoadRepository()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val coordinator = MobileConfigLoadCoordinator(
            repository,
            FakeValidator(),
            object : MobileCoreConfigLoader {
                override fun load(
                    configBytes: ByteArray,
                    expectedDigest: String,
                    injectFailure: Boolean,
                ): NativeConfigLoadResult {
                    entered.countDown()
                    assertTrue(release.await(5, TimeUnit.SECONDS))
                    return NativeConfigLoadResult(NativeLoadCode.LOADED, 0)
                }
            },
        )
        val cancelledArgs = args(repository.current(), CONFIG_A, "revision-a", "cancel-before")
        coordinator.cancel(cancelledArgs.operationId)
        val before = coordinator.load(cancelledArgs)
        assertEquals("cancelled", before.outcome)
        assertEquals("before-load", before.cancellation)
        assertEquals("unloaded", before.rollback)

        val executor = Executors.newSingleThreadExecutor()
        val pendingArgs = args(repository.current(), CONFIG_A, "revision-a", "cancel-late")
        val pending = executor.submit(Callable { coordinator.load(pendingArgs) })
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        assertTrue(coordinator.cancel(pendingArgs.operationId).accepted)
        release.countDown()
        val late = pending.get(5, TimeUnit.SECONDS)
        executor.shutdownNow()

        assertEquals("first-load", late.outcome)
        assertEquals("too-late", late.cancellation)
        assertEquals("loaded", late.snapshot.coreConfigState)
    }

    @Test
    fun `timeout and runtime replacement return typed truthful state`() {
        val timedRepository = LoadRepository()
        val times = ArrayDeque(listOf(100L, 500L))
        val timed = MobileConfigLoadCoordinator(
            timedRepository,
            FakeValidator(),
            FakeLoader(),
            clockMillis = { times.removeFirst() },
        ).load(
            args(timedRepository.current(), CONFIG_A, "revision-a").apply {
                timeoutMillis = 200
            },
        )
        assertEquals("timed-out", timed.timing)
        assertEquals("timeout", timed.failure)
        assertEquals("first-load", timed.outcome)
        assertEquals("loaded", timed.snapshot.coreConfigState)

        val replacedRepository = LoadRepository()
        val runtimeReplaced = MobileConfigLoadCoordinator(
            replacedRepository,
            FakeValidator(),
            object : MobileCoreConfigLoader {
                override fun load(
                    configBytes: ByteArray,
                    expectedDigest: String,
                    injectFailure: Boolean,
                ): NativeConfigLoadResult {
                    replacedRepository.replaceSession()
                    return NativeConfigLoadResult(NativeLoadCode.LOADED, 0)
                }
            },
        ).load(args(replacedRepository.current(), CONFIG_A, "revision-a"))

        assertEquals("runtime-replaced", runtimeReplaced.failure)
        assertEquals("unknown", runtimeReplaced.snapshot.coreConfigState)
        assertEquals("unknown", runtimeReplaced.rollback)
    }

    @Test
    fun `process recreation never restores loaded Core from persisted identity alone`() {
        val persisted = MobileVpnSnapshot(
            coreConfigState = "loaded",
            loadedConfigDigest = digest(CONFIG_A),
            loadedConfigRevision = "revision-a",
        )

        val recreated = reconcileCoreConfigSnapshot(
            persisted,
            NativeConfigInspectionResult(
                NativeInspectionCode.UNLOADED,
                abiStatus = 2,
            ),
        )
        val activityRecreated = reconcileCoreConfigSnapshot(
            persisted,
            NativeConfigInspectionResult(NativeInspectionCode.LOADED_EXPECTED),
        )
        val unexpected = reconcileCoreConfigSnapshot(
            persisted,
            NativeConfigInspectionResult(NativeInspectionCode.LOADED_OTHER),
        )

        assertEquals("unloaded", recreated.coreConfigState)
        assertNull(recreated.loadedConfigDigest)
        assertEquals("loaded", activityRecreated.coreConfigState)
        assertEquals("revision-a", activityRecreated.loadedConfigRevision)
        assertEquals("unknown", unexpected.coreConfigState)
    }
}

private const val CONFIG_A = "mode: rule\nproxies: []\nproxy-groups: []\nrules: []\n"
private const val CONFIG_B = "mode: direct\nproxies: []\nproxy-groups: []\nrules: []\n"
private const val CONFIG_C = "mode: global\nproxies: []\nproxy-groups: []\nrules: []\n"

private fun digest(config: String): String = sha256Hex(config.toByteArray())

private fun args(
    snapshot: MobileVpnSnapshot,
    config: String,
    revision: String,
    operationId: String = "operation-$revision",
): LoadConfigArgs =
    LoadConfigArgs().apply {
        configBytes = config.toByteArray().map { it.toInt() and 0xff }.toIntArray()
        this.digest = digest(config)
        injectFailure = false
        this.operationId = operationId
        this.revision = revision
        sequence = snapshot.sequence
        sessionId = snapshot.sessionId
        timeoutMillis = 5_000
    }

private class LoadRepository : SnapshotRepository {
    @Volatile
    private var snapshot = MobileVpnSnapshot(
        coreAbiVersion = 1,
        coreAvailability = "available",
        coreCommit = "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb",
        coreVersion = "v1.19.29",
        coreWrapperRevision = "mish-mobile-core-v1",
        sequence = 11,
        sessionId = "load-session",
    )

    override fun current(): MobileVpnSnapshot = snapshot

    override fun update(transform: (MobileVpnSnapshot) -> MobileVpnSnapshot): MobileVpnSnapshot =
        synchronized(this) {
            snapshot = transform(snapshot).copy(sequence = snapshot.sequence + 1)
            snapshot
        }

    fun replaceSession() {
        synchronized(this) {
            snapshot = snapshot.copy(sequence = 0, sessionId = "replacement-session")
        }
    }
}

private class FakeValidator(
    private val calls: MutableList<String>? = null,
    private val counter: AtomicInteger? = null,
) : MobileCoreConfigValidator {
    override fun validate(
        configBytes: ByteArray,
        expectedDigest: String,
    ): NativeConfigValidationResult {
        calls?.add("validate")
        counter?.incrementAndGet()
        assertEquals(sha256Hex(configBytes), expectedDigest)
        return NativeConfigValidationResult(NativeValidationCode.VALID, 0)
    }
}

private class FakeLoader(
    private val calls: MutableList<String>? = null,
) : MobileCoreConfigLoader {
    override fun load(
        configBytes: ByteArray,
        expectedDigest: String,
        injectFailure: Boolean,
    ): NativeConfigLoadResult {
        calls?.add("load")
        assertEquals(sha256Hex(configBytes), expectedDigest)
        return NativeConfigLoadResult(NativeLoadCode.LOADED, 0)
    }
}

private class SequencedLoader(
    vararg results: NativeConfigLoadResult,
) : MobileCoreConfigLoader {
    private val remaining = ArrayDeque(results.toList())
    val calls = AtomicInteger()

    override fun load(
        configBytes: ByteArray,
        expectedDigest: String,
        injectFailure: Boolean,
    ): NativeConfigLoadResult {
        calls.incrementAndGet()
        return remaining.removeFirst()
    }
}
