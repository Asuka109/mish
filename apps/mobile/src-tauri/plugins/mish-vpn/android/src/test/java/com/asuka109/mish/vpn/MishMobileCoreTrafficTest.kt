package com.asuka109.mish.vpn

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MishMobileCoreTrafficTest {
    @Test
    fun fakeNativeObservesAndClosesOnlyTheExactStableId() {
        val adapter = FakeMobileCoreTrafficAdapter()
        assertEquals(
            listOf("connection-a", "connection-b"),
            ids(MobileCoreTrafficCommandAdapter.snapshot(adapter)),
        )

        val closed = MobileCoreTrafficCommandAdapter.close(
            adapter,
            closeArgs("connection-a", "1", "traffic-session-a"),
        )
        assertTrue(closed.isNull("failure"))
        assertEquals(listOf("connection-b"), ids(closed.getJSONObject("snapshot")))

        val duplicate = MobileCoreTrafficCommandAdapter.close(
            adapter,
            closeArgs("connection-a", "2", "traffic-session-a"),
        )
        assertEquals("stale-connection", duplicate.getString("failure"))
        assertEquals(listOf("connection-b"), ids(duplicate.getJSONObject("snapshot")))

        adapter.replaceSession("connection-a")
        val replaced = MobileCoreTrafficCommandAdapter.close(
            adapter,
            closeArgs("connection-b", "2", "traffic-session-a"),
        )
        assertEquals("stale-connection", replaced.getString("failure"))
        assertEquals(listOf("connection-a"), ids(replaced.getJSONObject("snapshot")))
        assertEquals(1, adapter.mutationCount)
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

    @Test
    fun trafficEnvelopeUsesStrictUtf8BytesWithoutModifiedUtf8Loss() {
        val encoded = "{\"processName\":\"测试应用\"}".toByteArray(Charsets.UTF_8)
        assertEquals("{\"processName\":\"测试应用\"}", MishMobileCoreProbe.strictUtf8(encoded))
        assertNull(MishMobileCoreProbe.strictUtf8(byteArrayOf(0xC3.toByte(), 0x28)))
    }

    private fun ids(snapshot: JSONObject?): List<String> {
        val connections = snapshot?.getJSONArray("connections") ?: return emptyList()
        return buildList(connections.length()) {
            repeat(connections.length()) { add(connections.getJSONObject(it).getString("id")) }
        }
    }

    private fun closeArgs(connectionId: String, eventSequence: String, sessionId: String) =
        CloseTrafficConnectionArgs().apply {
            this.connectionId = connectionId
            this.eventSequence = eventSequence
            this.sessionId = sessionId
        }
}

private class FakeMobileCoreTrafficAdapter : MobileCoreTrafficAdapter {
    var mutationCount = 0
        private set
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
        mutationCount += 1
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
