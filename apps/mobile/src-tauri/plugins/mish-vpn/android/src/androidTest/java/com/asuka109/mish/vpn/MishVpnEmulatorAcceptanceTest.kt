package com.asuka109.mish.vpn

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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
    fun routeSelectionUsesOnlyTypedFakeNativeEffectsAndRecreationGetsFullBaseline() {
        val core = EmulatorRoutes()
        val command = routeArgs("route-emulator-1", "proxy:beta", "Beta")

        val selected = MobileCoreRouteAdapter.execute(core, command)
        val duplicate = MobileCoreRouteAdapter.execute(core, command)
        val invalid = MobileCoreRouteAdapter.execute(
            core,
            routeArgs("route-invalid", "proxy:unknown", "Unknown"),
        )
        core.runtimeAuthority = "runtime-replacement"
        val delayed = MobileCoreRouteAdapter.execute(
            core,
            routeArgs("route-delayed", "proxy:alpha", "Alpha"),
        )
        val recreatedComponentBaseline = MobileCoreRouteAdapter.execute(core, RouteOperationArgs())

        assertEquals("Beta", selected.getJSONObject("routes").getJSONArray("groups")
            .getJSONObject(0).getString("selected"))
        assertEquals(1, core.mutationCount)
        assertNull(duplicate.opt("failure"))
        assertEquals("invalid-request", invalid.getString("failure"))
        assertEquals("conflict", delayed.getString("failure"))
        assertEquals(1, core.mutationCount)
        assertEquals("Beta", recreatedComponentBaseline.getJSONObject("routes")
            .getJSONArray("groups").getJSONObject(0).getString("selected"))
        assertEquals("session-emulator", recreatedComponentBaseline.getJSONObject("status")
            .getString("sessionId"))
    }

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
    fun trafficTranscriptObservesClosesExactIdAndRejectsReplacedId() {
        val transcript = EmulatorLifecycleTranscript(EmulatorScenario.TRAFFIC_EXACT_CLOSE)
        val authority = authority("1")
        val nativeEffects = EmulatorTraffic()
        val baseline = MobileCoreTrafficCommandAdapter.snapshot(nativeEffects)
        transcript.record(authority, "traffic-observe", "observed")
        assertEquals(listOf("connection-current"), trafficIds(baseline))

        transcript.record(authority.copy(effectIdentity = "2"), "traffic-view-pause", "applied")
        assertEquals(listOf("connection-current"), trafficIds(MobileCoreTrafficCommandAdapter.snapshot(nativeEffects)))
        transcript.record(authority.copy(effectIdentity = "3"), "traffic-view-resume", "applied")

        val close = MobileCoreTrafficCommandAdapter.close(
            nativeEffects,
            trafficArgs("connection-current", "1", "traffic-session-current"),
        )
        assertTrue(close.isNull("failure"))
        assertTrue(trafficIds(close.getJSONObject("snapshot")).isEmpty())
        assertEquals(1, nativeEffects.mutationCount)
        transcript.record(authority.copy(effectIdentity = "4"), "traffic-close-one", "completed")

        nativeEffects.replaceSession()
        transcript.record(authority.copy(scopeEpoch = 2, effectIdentity = "1"), "traffic-replacement", "replaced")
        val stale = MobileCoreTrafficCommandAdapter.close(
            nativeEffects,
            trafficArgs("connection-current", "2", "traffic-session-current"),
        )
        assertEquals("stale-connection", stale.getString("failure"))
        assertEquals(listOf("connection-replacement"), trafficIds(stale.getJSONObject("snapshot")))
        assertEquals(1, nativeEffects.mutationCount)
        transcript.record(authority.copy(scopeEpoch = 2, effectIdentity = "2"), "traffic-close-one", "retired")
        assertEquals(transcript, EmulatorLifecycleTranscript.parse(transcript.toJson().toString()))
    }

    private fun trafficArgs(connectionId: String, eventSequence: String, sessionId: String) =
        CloseTrafficConnectionArgs().apply {
            this.connectionId = connectionId
            this.eventSequence = eventSequence
            this.sessionId = sessionId
        }

    private fun trafficIds(snapshot: JSONObject): List<String> {
        val connections = snapshot.getJSONArray("connections")
        return buildList(connections.length()) {
            repeat(connections.length()) { add(connections.getJSONObject(it).getString("id")) }
        }
    }

    private fun authority(effectIdentity: String): CoreLifecycleAuthority = CoreLifecycleAuthority(
        machineAuthority = "vpn-authority-acceptance",
        scopeEpoch = 1,
        operationId = "operation-acceptance",
        admittedRevision = 1,
        effectIdentity = effectIdentity,
    )

    private fun routeArgs(operationId: String, childId: String, nativeChild: String) =
        RouteOperationArgs().apply {
            this.childId = childId
            currentChildId = "proxy:alpha"
            groupId = "group:proxy"
            this.nativeChild = nativeChild
            nativeCurrentChild = "Alpha"
            nativeGroup = "Proxy"
            this.operationId = operationId
            profileId = "profile-emulator"
            profileRevision = "revision-emulator"
            runtimeAuthority = "runtime-emulator"
        }
}

private class EmulatorTraffic : MobileCoreTrafficAdapter {
    var mutationCount = 0
        private set
    private var sequence = 1
    private var sessionId = "traffic-session-current"
    private val connections = linkedSetOf("connection-current")

    override fun snapshotTraffic(): JSONObject = snapshot()

    override fun closeTrafficConnection(
        connectionId: String,
        eventSequence: String,
        sessionId: String,
    ): NativeTrafficCloseResult {
        if (eventSequence != sequence.toString() || sessionId != this.sessionId) {
            return NativeTrafficCloseResult("stale-connection", snapshot())
        }
        if (!connections.remove(connectionId)) {
            return NativeTrafficCloseResult("stale-connection", snapshot())
        }
        mutationCount += 1
        sequence += 1
        return NativeTrafficCloseResult(null, snapshot())
    }

    fun replaceSession() {
        sessionId = "traffic-session-replacement"
        sequence = 1
        connections.clear()
        connections += "connection-replacement"
    }

    private fun snapshot(): JSONObject = JSONObject()
        .put(
            "connections",
            JSONArray(
                connections.map { connectionId ->
                    JSONObject()
                        .put("id", connectionId)
                        .put("processName", "Fixture App")
                        .put("routeChain", JSONArray(listOf("Fixture Group", "Fixture Exit")))
                },
            ),
        )
        .put("eventSequence", sequence.toString())
        .put("running", true)
        .put("sessionId", sessionId)
        .put("truncated", false)
}

private class EmulatorRoutes : MobileCoreRoutes {
    var mutationCount = 0
    var runtimeAuthority = "runtime-emulator"
    private var selected = "Alpha"
    private val completed = mutableMapOf<String, String>()

    override fun snapshot(): NativeRouteOperationResult = response(null, 0)

    override fun select(
        operationId: String,
        runtimeAuthority: String,
        profileId: String,
        profileRevision: String,
        groupId: String,
        currentChildId: String,
        childId: String,
        nativeGroup: String,
        nativeCurrentChild: String,
        nativeChild: String,
    ): NativeRouteOperationResult {
        if (runtimeAuthority != this.runtimeAuthority) return response(operationId, 5)
        val fingerprint = listOf(
            profileId, profileRevision, groupId, currentChildId, childId,
            nativeGroup, nativeCurrentChild, nativeChild,
        ).joinToString("|")
        completed[operationId]?.let { return response(operationId, if (it == fingerprint) 0 else 5) }
        if (nativeGroup != "Proxy" || nativeCurrentChild != selected || nativeChild !in setOf("Alpha", "Beta")) {
            return response(operationId, 1)
        }
        completed[operationId] = fingerprint
        selected = nativeChild
        mutationCount += 1
        return response(operationId, 0)
    }

    private fun response(operationId: String?, commandStatus: Int): NativeRouteOperationResult {
        fun envelope(data: JSONObject) = JSONObject().put("abiVersion", 1).put("data", data).toString()
        val status = envelope(JSONObject()
            .put("configSha256", "a".repeat(64))
            .put("eventSequence", mutationCount.toString())
            .put("loaded", true)
            .put("mode", "rule")
            .put("phase", "running")
            .put("sessionId", "session-emulator"))
        val routes = envelope(JSONObject()
            .put("groups", JSONArray().put(JSONObject()
                .put("candidates", JSONArray().put("Alpha").put("Beta"))
                .put("name", "Proxy")
                .put("selected", selected)))
            .put("mode", "rule")
            .put("truncated", false))
        return NativeRouteOperationResult(
            commandStatus,
            if (operationId == null) null else envelope(JSONObject().put("eventSequence", mutationCount.toString())),
            0,
            status,
            0,
            routes,
        )
    }
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
            "mobile-core-admission",
            "process-recreated",
            "stale-delivery",
            "traffic-close-one",
            "traffic-observe",
            "traffic-replacement",
            "traffic-view-pause",
            "traffic-view-resume",
        )
        private val RESULTS = setOf(
            "applied",
            "completed",
            "duplicate",
            "observed",
            "rejected",
            "replaced",
            "retired",
            "retryable",
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
    RECREATION_CLEANUP_RETRY("recreation-cleanup-retry"),
    TRAFFIC_EXACT_CLOSE("traffic-exact-close");

    companion object {
        fun fromWireName(value: String): EmulatorScenario? = entries.singleOrNull { it.wireName == value }
    }
}
