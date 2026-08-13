package com.asuka109.mish.vpn

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MishMobileCoreRoutesTest {
    @Test
    fun `typed adapter carries authority ids and native labels without owning selection state`() {
        val core = FakeRoutes()
        val args = selectionArgs()

        val result = MobileCoreRouteAdapter.execute(core, args)

        assertNull(result.opt("failure"))
        assertEquals("route-1", result.getString("operationId"))
        assertEquals("Beta", result.getJSONObject("routes").getJSONArray("groups")
            .getJSONObject(0).getString("selected"))
        assertEquals(
            SelectionCall(
                "route-1", "runtime-a", "profile-a", "revision-a",
                "group:stable", "proxy:alpha", "proxy:beta",
                "Proxy", "Alpha", "Beta",
            ),
            core.call,
        )
    }

    @Test
    fun `snapshot path has no command and malformed envelopes fail closed`() {
        val core = FakeRoutes(malformed = true)

        val result = MobileCoreRouteAdapter.execute(core, RouteOperationArgs())

        assertEquals("malformed-response", result.getString("failure"))
        assertNull(core.call)
    }

    @Test
    fun `invalid stable identity is rejected before fake native effect`() {
        val core = FakeRoutes()
        val args = selectionArgs().apply { groupId = "group with spaces" }

        val result = MobileCoreRouteAdapter.execute(core, args)

        assertEquals("invalid-request", result.getString("failure"))
        assertNull(core.call)
    }

    @Test
    fun `native conflict returns only a bounded code and leaves baseline ownership to Rust`() {
        val core = FakeRoutes(commandStatus = 5)

        val result = MobileCoreRouteAdapter.execute(core, selectionArgs())

        assertEquals("conflict", result.getString("failure"))
        assertEquals("runtime-a", core.call?.runtimeAuthority)
        assertTrue(result.getJSONObject("routes").getJSONArray("groups").length() == 0)
    }

    private fun selectionArgs() = RouteOperationArgs().apply {
        childId = "proxy:beta"
        currentChildId = "proxy:alpha"
        groupId = "group:stable"
        nativeChild = "Beta"
        nativeCurrentChild = "Alpha"
        nativeGroup = "Proxy"
        operationId = "route-1"
        profileId = "profile-a"
        profileRevision = "revision-a"
        runtimeAuthority = "runtime-a"
    }
}

private data class SelectionCall(
    val operationId: String,
    val runtimeAuthority: String,
    val profileId: String,
    val profileRevision: String,
    val groupId: String,
    val currentChildId: String,
    val childId: String,
    val nativeGroup: String,
    val nativeCurrentChild: String,
    val nativeChild: String,
)

private class FakeRoutes(
    private val malformed: Boolean = false,
    private val commandStatus: Int = 0,
) : MobileCoreRoutes {
    var call: SelectionCall? = null

    override fun snapshot(): NativeRouteOperationResult = response(null)

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
        call = SelectionCall(
            operationId, runtimeAuthority, profileId, profileRevision,
            groupId, currentChildId, childId, nativeGroup, nativeCurrentChild, nativeChild,
        )
        return response(operationId)
    }

    private fun response(operationId: String?): NativeRouteOperationResult {
        val command = envelope(JSONObject().put("eventSequence", "7"))
        val status = if (malformed) {
            JSONObject().put("abiVersion", 1).put("data", JSONObject()).put("unexpected", true).toString()
        } else {
            envelope(JSONObject()
                .put("configSha256", "a".repeat(64))
                .put("eventSequence", "7")
                .put("loaded", true)
                .put("mode", "rule")
                .put("phase", "running")
                .put("sessionId", "session-a"))
        }
        val routes = envelope(JSONObject()
            .put("groups", org.json.JSONArray().put(JSONObject()
                .put("candidates", org.json.JSONArray().put("Alpha").put("Beta"))
                .put("name", "Proxy")
                .put("selected", if (operationId == null) "Alpha" else "Beta")))
            .put("mode", "rule")
            .put("truncated", false))
        return NativeRouteOperationResult(
            commandStatus = commandStatus,
            commandEnvelope = if (operationId == null) null else command,
            statusStatus = 0,
            statusEnvelope = status,
            routesStatus = 0,
            routesEnvelope = routes,
        )
    }

    private fun envelope(data: JSONObject): String = JSONObject()
        .put("abiVersion", 1)
        .put("data", data)
        .toString()
}
