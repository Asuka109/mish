package com.asuka109.mish.vpn

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MishMobileCoreValidationTest {
    @Test
    fun `Tauri payload bytes and authority decode into the closed Kotlin arguments`() {
        val parsed = ObjectMapper().readValue(
            """{"configBytes":[0,127,255],"sequence":11,"sessionId":"validation-session"}""",
            ValidateConfigArgs::class.java,
        )

        assertEquals(listOf(0, 127, 255), parsed.configBytes.toList())
        assertEquals(11, parsed.sequence)
        assertEquals("validation-session", parsed.sessionId)

        val encoded = JSONObject(
            ObjectMapper().writeValueAsString(
                MobileConfigValidationResult.valid(ValidationRepository().current()),
            ),
        )
        assertEquals(CONTRACT_VERSION, encoded.getInt("contractVersion"))
        assertEquals("valid", encoded.getString("outcome"))
    }

    @Test
    fun `valid and rejected fictional bytes preserve VPN and Core snapshot state`() {
        val repository = ValidationRepository()
        val initial = repository.current()
        val validator = SequencedValidator(
            NativeConfigValidationResult(NativeValidationCode.VALID, 0),
            NativeConfigValidationResult(NativeValidationCode.CONFIG_REJECTED, 4),
        )
        val coordinator = MobileConfigValidationCoordinator(repository, validator)

        val valid = coordinator.validate(args(initial, "mode: rule\nproxies: []\nrules: []\n"))
        val invalid = coordinator.validate(
            args(initial, "external-controller: 127.0.0.1:9090\nproxies: []\nrules: []\n"),
        )

        assertEquals("valid", valid.outcome)
        assertEquals(null, valid.failure)
        assertEquals("invalid", invalid.outcome)
        assertEquals("configuration-rejected", invalid.failure)
        assertEquals(initial, repository.current())
        assertEquals("unavailable", repository.current().coreAvailability)
        assertFalse(repository.current().vpnActive)
    }

    @Test
    fun `oversized input is rejected before native validation`() {
        val repository = ValidationRepository()
        val calls = AtomicInteger()
        val coordinator = MobileConfigValidationCoordinator(
            repository,
            object : MobileCoreConfigValidator {
                override fun validate(configBytes: ByteArray): NativeConfigValidationResult {
                    calls.incrementAndGet()
                    return NativeConfigValidationResult(NativeValidationCode.VALID)
                }
            },
        )
        val initial = repository.current()
        val args = ValidateConfigArgs().apply {
            configBytes = IntArray(MOBILE_CORE_MAX_CONFIG_BYTES_V1 + 1)
            sequence = initial.sequence
            sessionId = initial.sessionId
        }

        val result = coordinator.validate(args)

        assertEquals("configuration-too-large", result.failure)
        assertEquals(0, calls.get())
        assertEquals(initial, repository.current())
    }

    @Test
    fun `worker failures resolve to a redacted plugin result`() {
        val repository = ValidationRepository()
        val calls = AtomicInteger()
        val coordinator = MobileConfigValidationCoordinator(
            repository,
            object : MobileCoreConfigValidator {
                override fun validate(configBytes: ByteArray): NativeConfigValidationResult {
                    calls.incrementAndGet()
                    return NativeConfigValidationResult(NativeValidationCode.VALID)
                }
            },
        )
        val initial = repository.current()
        val malformed = ValidateConfigArgs().apply {
            sequence = initial.sequence
            sessionId = initial.sessionId
        }

        val result = validateConfigSafely(coordinator, malformed, repository::current)

        assertEquals("plugin-failure", result.failure)
        assertEquals("failed", result.outcome)
        assertEquals(0, calls.get())
        assertEquals(initial, repository.current())
    }

    @Test
    fun `duplicate commands are rejected while one native validation is pending`() {
        val repository = ValidationRepository()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val coordinator = MobileConfigValidationCoordinator(
            repository,
            object : MobileCoreConfigValidator {
                override fun validate(configBytes: ByteArray): NativeConfigValidationResult {
                    entered.countDown()
                    assertTrue(release.await(5, TimeUnit.SECONDS))
                    return NativeConfigValidationResult(NativeValidationCode.VALID)
                }
            },
        )
        val executor = Executors.newSingleThreadExecutor()
        val initial = repository.current()
        val pending = executor.submit(Callable {
            coordinator.validate(args(initial, "mode: rule\nrules: []\n"))
        })
        assertTrue(entered.await(5, TimeUnit.SECONDS))

        val duplicate = coordinator.validate(args(initial, "mode: direct\nrules: []\n"))
        release.countDown()
        val completed = pending.get(5, TimeUnit.SECONDS)
        executor.shutdownNow()

        assertEquals("duplicate-command", duplicate.failure)
        assertEquals("valid", completed.outcome)
        assertEquals(initial, repository.current())
    }

    @Test
    fun `native status classifications map to bounded product failures`() {
        val repository = ValidationRepository()
        val initial = repository.current()
        val expected = listOf(
            NativeValidationCode.CORE_UNAVAILABLE to "core-unavailable",
            NativeValidationCode.INITIALIZATION_FAILED to "core-initialization-failed",
            NativeValidationCode.MALFORMED_RESPONSE to "malformed-native-response",
            NativeValidationCode.RESPONSE_TOO_LARGE to "native-response-too-large",
            NativeValidationCode.NATIVE_FAILED to "native-validation-failed",
        )

        for ((nativeCode, failure) in expected) {
            val coordinator = MobileConfigValidationCoordinator(
                repository,
                SequencedValidator(NativeConfigValidationResult(nativeCode, 8)),
            )
            val result = coordinator.validate(args(initial, "mode: rule\nrules: []\n"))
            assertEquals(failure, result.failure)
            assertEquals("failed", result.outcome)
            assertTrue(result.message.length <= 256)
        }
        assertEquals(initial, repository.current())
    }

    @Test
    fun `stale authority and malformed JNI results fail without exposing input`() {
        val repository = ValidationRepository()
        val initial = repository.current()
        val secret = "password: fictional-secret"
        val coordinator = MobileConfigValidationCoordinator(
            repository,
            SequencedValidator(
                MishMobileCoreProbe.parseValidation(intArrayOf(99, 0)),
            ),
        )
        val staleArgs = args(initial, secret).apply { sequence += 1 }

        val stale = coordinator.validate(staleArgs)
        val failed = coordinator.validate(args(initial, secret))

        assertEquals("stale-authority", stale.failure)
        assertEquals("native-validation-failed", failed.failure)
        assertFalse(stale.toJson().toString().contains(secret))
        assertFalse(failed.toJson().toString().contains(secret))
        assertEquals(
            NativeValidationCode.MALFORMED_RESPONSE,
            MishMobileCoreProbe.parseValidation(intArrayOf(1)).code,
        )
        assertEquals(initial, repository.current())
    }
}

private fun args(snapshot: MobileVpnSnapshot, config: String): ValidateConfigArgs =
    ValidateConfigArgs().apply {
        configBytes = config.toByteArray().map { it.toInt() and 0xff }.toIntArray()
        sequence = snapshot.sequence
        sessionId = snapshot.sessionId
    }

private class ValidationRepository : SnapshotRepository {
    private val snapshot = MobileVpnSnapshot(
        coreAvailability = "unavailable",
        phase = VpnPhase.STOPPED.wireName,
        sequence = 11,
        sessionId = "validation-session",
        vpnActive = false,
    )

    override fun current(): MobileVpnSnapshot = snapshot

    override fun update(transform: (MobileVpnSnapshot) -> MobileVpnSnapshot): MobileVpnSnapshot {
        throw AssertionError("Configuration validation must not update VPN state")
    }
}

private class SequencedValidator(
    vararg results: NativeConfigValidationResult,
) : MobileCoreConfigValidator {
    private val remaining = ArrayDeque(results.toList())

    override fun validate(configBytes: ByteArray): NativeConfigValidationResult =
        remaining.removeFirst()
}
