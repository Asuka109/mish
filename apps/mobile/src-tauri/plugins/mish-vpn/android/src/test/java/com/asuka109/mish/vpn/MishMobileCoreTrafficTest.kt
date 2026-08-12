package com.asuka109.mish.vpn

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MishMobileCoreTrafficTest {
    @Test
    fun fakeNativeObservesAndClosesOnlyTheExactStableId() {
        val adapter = FakeMobileCoreTrafficAdapter()
        assertEquals(listOf("connection-a", "connection-b"), ids(adapter.snapshotTraffic()))

        val closed = adapter.closeTrafficConnection("connection-a", "1", "traffic-session-a")
        assertNull(closed.failure)
        assertEquals(listOf("connection-b"), ids(closed.snapshot))

        val duplicate = adapter.closeTrafficConnection("connection-a", "2", "traffic-session-a")
        assertEquals("stale-connection", duplicate.failure)
        assertEquals(listOf("connection-b"), ids(duplicate.snapshot))

        adapter.replaceSession("connection-a")
        val replaced = adapter.closeTrafficConnection("connection-b", "2", "traffic-session-a")
        assertEquals("stale-connection", replaced.failure)
        assertEquals(listOf("connection-a"), ids(replaced.snapshot))
    }

    @Test
    fun strictSnapshotEnvelopeRejectsRawNativeOrPrivateFields() {
        val valid = JSONObject()
            .put("abiVersion", 1)
            .put("data", FakeMobileCoreTrafficAdapter().snapshotTraffic())
        val parsed = MishMobileCoreProbe.parseTrafficSnapshotEnvelope(valid.toString())
        assertEquals("traffic-session-a", parsed?.getString("sessionId"))

        valid.put("nativePointer", "0x1234")
        assertNull(MishMobileCoreProbe.parseTrafficSnapshotEnvelope(valid.toString()))
    }

    @Test
    fun closeEnvelopeCarriesTheAuthoritativeSnapshotInTheSameNativeCall() {
        val closed = JSONObject()
            .put("abiVersion", 1)
            .put(
                "data",
                JSONObject()
                    .put("failure", JSONObject.NULL)
                    .put("snapshot", FakeMobileCoreTrafficAdapter().snapshotTraffic()),
            )
        val result = MishMobileCoreProbe.parseNativeCloseResult(closed.toString())
        assertNull(result?.failure)
        assertEquals(listOf("connection-a", "connection-b"), ids(result?.snapshot))

        closed.getJSONObject("data").put("privateStore", "forbidden")
        assertNull(MishMobileCoreProbe.parseNativeCloseResult(closed.toString()))
    }

    private fun ids(snapshot: JSONObject?): List<String> {
        val connections = snapshot?.getJSONArray("connections") ?: return emptyList()
        return buildList(connections.length()) {
            repeat(connections.length()) { add(connections.getJSONObject(it).getString("id")) }
        }
    }
}

private class FakeMobileCoreTrafficAdapter : MobileCoreTrafficAdapter {
    private var sessionId = "traffic-session-a"
    private var sequence = 1
    private val connections = linkedSetOf("connection-a", "connection-b")

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
        sequence += 1
        return NativeTrafficCloseResult(null, snapshot())
    }

    fun replaceSession(connectionId: String) {
        sessionId = "traffic-session-b"
        sequence = 1
        connections.clear()
        connections += connectionId
    }

    private fun snapshot(): JSONObject = JSONObject()
        .put(
            "connections",
            JSONArray(
                connections.map { id ->
                    JSONObject()
                        .put("destinationHost", "traffic.fixture.invalid")
                        .put("destinationIp", "192.0.2.44")
                        .put("destinationPort", 443)
                        .put("downloadBytes", "2")
                        .put("id", id)
                        .put("matchedRulePayload", "fixture.invalid")
                        .put("matchedRuleType", "DomainSuffix")
                        .put("network", "tcp")
                        .put("processName", "Fixture App")
                        .put("protocol", "Tun")
                        .put("providerChain", JSONArray())
                        .put("remoteDestination", JSONObject.NULL)
                        .put("routeChain", JSONArray(listOf("Fixture Group", "Fixture Exit")))
                        .put("sniffHost", JSONObject.NULL)
                        .put("sourcePort", 40_000)
                        .put("startedAt", "2026-08-13T00:00:00Z")
                        .put("uploadBytes", "1")
                },
            ),
        )
        .put("eventSequence", sequence.toString())
        .put("running", true)
        .put("sessionId", sessionId)
        .put("truncated", false)
}
