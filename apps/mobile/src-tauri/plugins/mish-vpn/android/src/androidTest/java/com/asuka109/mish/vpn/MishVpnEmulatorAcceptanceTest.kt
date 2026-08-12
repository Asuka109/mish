package com.asuka109.mish.vpn

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Credential-free emulator acceptance for the Android process/storage seam.
 *
 * This test never starts [MishVpnService], asks for VPN consent, establishes a
 * TUN, loads Mobile Core, or performs a network request. It drives the real
 * Kotlin authority, durable recovery, admission, and per-resource cleanup
 * contracts with closed synthetic effects only.
 */
class MishVpnEmulatorAcceptanceTest {
    @Test
    fun lifecycleAuthoritySurvivesRecreationAndCleanupRetryWithoutPlatformEffects() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val authority = authority(effectIdentity = "2")
        val transcript = EmulatorLifecycleTranscript(EmulatorScenario.RECREATION_CLEANUP_RETRY)

        val firstComponent = MishVpnPlatformStore(context)
        firstComponent.serviceStopped()
        assertTrue(firstComponent.lifecycleAuthorityAdvanced("service-acceptance-1", authority))
        transcript.record(authority, "authority-persisted", "applied")
        assertTrue(firstComponent.lifecycleAuthorityAdvanced("service-acceptance-1", authority))
        transcript.record(authority, "authority-persisted", "duplicate")

        val replacement = authority.copy(scopeEpoch = 2, admittedRevision = 1, effectIdentity = "1")
        assertTrue(firstComponent.lifecycleAuthorityAdvanced("service-acceptance-2", replacement))
        transcript.record(replacement, "authority-persisted", "replaced")

        // A new store instance takes the same path as an Android component or
        // application-process bootstrap reading the durable recovery record.
        val recreatedComponent = MishVpnPlatformStore(context)
        val recovered = recreatedComponent.current()
        assertEquals(PlatformRecoveryEvidence.FOREGROUND_EXPECTED.wireName, recovered.recoveryEvidence)
        assertEquals(replacement, recovered.lifecycleAuthority)
        transcript.record(replacement, "process-recreated", "observed")

        val stale = authority.copy(effectIdentity = "1")
        assertFalse(recreatedComponent.lifecycleAuthorityAdvanced("service-acceptance-stale", stale))
        assertEquals(replacement, recreatedComponent.current().lifecycleAuthority)
        transcript.record(stale, "stale-delivery", "retired")

        val cleanup = MishVpnOwnedResourceCleanup()
        var coreAttempts = 0
        var tunAttempts = 0
        var networkAttempts = 0
        assertFalse(
            cleanup.cleanup(
                stopCore = { ++coreAttempts > 1 },
                closeTun = { ++tunAttempts; true },
                unregisterNetwork = { ++networkAttempts; true },
            ),
        )
        assertTrue(cleanup.recoveryState().retryable)
        assertEquals(MishVpnCleanupState.RETRYABLE, cleanup.recoveryState().cleanupState)
        transcript.record(replacement.copy(effectIdentity = "2"), "cleanup", "retryable")

        assertTrue(
            cleanup.cleanup(
                stopCore = { ++coreAttempts > 1 },
                closeTun = { ++tunAttempts; true },
                unregisterNetwork = { ++networkAttempts; true },
            ),
        )
        assertEquals(2, coreAttempts)
        assertEquals(1, tunAttempts)
        assertEquals(1, networkAttempts)
        recreatedComponent.serviceStopped()
        transcript.record(replacement.copy(effectIdentity = "3"), "cleanup", "completed")

        val cleanBootstrap = MishVpnPlatformStore(context).current()
        assertEquals(PlatformRecoveryEvidence.NONE.wireName, cleanBootstrap.recoveryEvidence)
        assertNull(cleanBootstrap.lifecycleAuthority)
        assertEquals(transcript, EmulatorLifecycleTranscript.parse(transcript.toJson().toString()))
    }

    @Test
    fun mobileCoreAdmissionRejectsBeforeAnyEffectAndTranscriptSchemaFailsClosed() {
        var effects = 0
        val rejection = MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.SOURCE_MISMATCH)
        val gate = MobileCoreAdmissionGate(admit = { rejection })
        val result = gate.invoke(
            operation = MobileCoreEffectOperation.START,
            rejected = { it },
            effect = {
                effects += 1
                MobileCoreAdmissionResult.accepted("x86_64", "a".repeat(64))
            },
        )
        assertEquals(MobileCoreAdmissionFailure.SOURCE_MISMATCH, result.failure)
        assertEquals(0, effects)

        val transcript = EmulatorLifecycleTranscript(EmulatorScenario.ADMISSION_REJECTED)
        transcript.record(authority("1"), "mobile-core-admission", "rejected")
        val encoded = transcript.toJson()
        assertEquals(transcript, EmulatorLifecycleTranscript.parse(encoded.toString()))

        encoded.put("unknownField", true)
        assertNull(EmulatorLifecycleTranscript.parse(encoded.toString()))

        val overflow = JSONObject(transcript.toJson().toString())
        val events = JSONArray()
        repeat(EmulatorLifecycleTranscript.EVENT_LIMIT + 1) {
            events.put(transcript.toJson().getJSONArray("events").getJSONObject(0))
        }
        overflow.put("events", events)
        assertNull(EmulatorLifecycleTranscript.parse(overflow.toString()))
    }

    @Test
    fun fixedDiagnosticDemoUsesClosedFakeEffectAndMatchingCancellationWithoutNetwork() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val transcript = EmulatorLifecycleTranscript(EmulatorScenario.FIXED_DIAGNOSTIC_DEMO)
        val effect = MishFixedDiagnosticEffect { cancellation ->
            entered.countDown()
            release.await(1, TimeUnit.SECONDS)
            if (cancellation.isCancelled()) {
                MishFixedDiagnosticTransportResult.CANCELLED
            } else {
                MishFixedDiagnosticTransportResult.COMPLETED
            }
        }
        var result: app.tauri.plugin.JSObject? = null
        val worker = thread { result = effect.run("run-acceptance-1") }
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        transcript.record(authority("1"), "fixed-diagnostic", "started")
        assertFalse(effect.cancel("retired-run"))
        transcript.record(authority("2"), "stale-delivery", "retired")
        assertTrue(effect.cancel("run-acceptance-1"))
        transcript.record(authority("3"), "fixed-diagnostic", "cancelled")
        release.countDown()
        worker.join(1_000)
        assertEquals("cancelled", result?.getString("outcome"))
        assertFalse(result.toString().contains("https://"))
        assertEquals(transcript, EmulatorLifecycleTranscript.parse(transcript.toJson().toString()))
    }

    private fun authority(effectIdentity: String): CoreLifecycleAuthority = CoreLifecycleAuthority(
        machineAuthority = "vpn-authority-acceptance",
        scopeEpoch = 1,
        operationId = "operation-acceptance",
        admittedRevision = 1,
        effectIdentity = effectIdentity,
    )
}

private data class EmulatorLifecycleEvent(
    val admittedRevision: Long,
    val effect: String,
    val effectIdentity: String,
    val logicalTime: Int,
    val result: String,
    val scopeEpoch: Long,
)

private data class EmulatorLifecycleTranscript(
    val scenario: EmulatorScenario,
    val events: MutableList<EmulatorLifecycleEvent> = mutableListOf(),
) {
    fun record(authority: CoreLifecycleAuthority, effect: String, result: String) {
        check(events.size < EVENT_LIMIT) { "Android emulator transcript overflow" }
        check(effect in EFFECTS && result in RESULTS)
        events += EmulatorLifecycleEvent(
            admittedRevision = authority.admittedRevision,
            effect = effect,
            effectIdentity = authority.effectIdentity,
            logicalTime = events.size + 1,
            result = result,
            scopeEpoch = authority.scopeEpoch,
        )
    }

    fun toJson(): JSONObject = JSONObject()
        .put("events", JSONArray(events.map { event ->
            JSONObject()
                .put("admittedRevision", event.admittedRevision)
                .put("effect", event.effect)
                .put("effectIdentity", event.effectIdentity)
                .put("logicalTime", event.logicalTime)
                .put("result", event.result)
                .put("scopeEpoch", event.scopeEpoch)
        }))
        .put("scenario", scenario.wireName)
        .put("schemaVersion", SCHEMA_VERSION)

    companion object {
        const val EVENT_LIMIT = 32
        private const val SCHEMA_VERSION = 2
        private val EFFECTS = setOf(
            "authority-persisted",
            "cleanup",
            "fixed-diagnostic",
            "mobile-core-admission",
            "process-recreated",
            "stale-delivery",
        )
        private val RESULTS = setOf(
            "applied",
            "cancelled",
            "completed",
            "duplicate",
            "observed",
            "rejected",
            "replaced",
            "retired",
            "retryable",
            "started",
        )

        fun parse(encoded: String): EmulatorLifecycleTranscript? = runCatching {
            val root = JSONObject(encoded)
            require(root.keys().asSequence().toSet() == setOf("events", "scenario", "schemaVersion"))
            require(root.getInt("schemaVersion") == SCHEMA_VERSION)
            val scenario = EmulatorScenario.fromWireName(root.getString("scenario"))
            require(scenario != null)
            val values = root.getJSONArray("events")
            require(values.length() in 1..EVENT_LIMIT)
            val transcript = EmulatorLifecycleTranscript(scenario)
            repeat(values.length()) { index ->
                val event = values.getJSONObject(index)
                require(
                    event.keys().asSequence().toSet() == setOf(
                        "admittedRevision",
                        "effect",
                        "effectIdentity",
                        "logicalTime",
                        "result",
                        "scopeEpoch",
                    ),
                )
                val effect = event.getString("effect")
                val result = event.getString("result")
                val effectIdentity = event.getString("effectIdentity")
                val admittedRevision = event.getLong("admittedRevision")
                val scopeEpoch = event.getLong("scopeEpoch")
                require(effect in EFFECTS && result in RESULTS)
                require(effectIdentity.toLongOrNull()?.let { it in 1..ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX } == true)
                require(admittedRevision in 1..ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX)
                require(scopeEpoch in 1..ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX)
                require(event.getInt("logicalTime") == index + 1)
                transcript.events += EmulatorLifecycleEvent(
                    admittedRevision,
                    effect,
                    effectIdentity,
                    index + 1,
                    result,
                    scopeEpoch,
                )
            }
            transcript
        }.getOrNull()
    }
}

private enum class EmulatorScenario(val wireName: String) {
    ADMISSION_REJECTED("admission-rejected"),
    FIXED_DIAGNOSTIC_DEMO("fixed-diagnostic-demo"),
    RECREATION_CLEANUP_RETRY("recreation-cleanup-retry");

    companion object {
        fun fromWireName(value: String): EmulatorScenario? = entries.singleOrNull { it.wireName == value }
    }
}
