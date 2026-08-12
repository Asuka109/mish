package com.asuka109.mish.vpn

import app.tauri.annotation.InvokeArg
import org.json.JSONArray
import org.json.JSONObject

@InvokeArg
internal class RouteOperationArgs {
    var childId: String? = null
    var currentChildId: String? = null
    var groupId: String? = null
    var nativeChild: String? = null
    var nativeCurrentChild: String? = null
    var nativeGroup: String? = null
    var operationId: String? = null
    var profileId: String? = null
    var profileRevision: String? = null
    var runtimeAuthority: String? = null
}

internal object MobileCoreRouteAdapter {
    private const val MAX_ENVELOPE_BYTES = 262_144

    fun execute(core: MobileCoreRoutes, args: RouteOperationArgs): JSONObject {
        val operationId = args.operationId
        val selecting = operationId != null
        val identifier = Regex("^[A-Za-z0-9._:-]{1,128}$")
        if (
            (selecting && listOf(
                args.childId,
                args.currentChildId,
                args.groupId,
                args.nativeChild,
                args.nativeCurrentChild,
                args.nativeGroup,
            ).any { it == null }) ||
            (!selecting && listOf(
                args.childId,
                args.currentChildId,
                args.groupId,
                args.nativeChild,
                args.nativeCurrentChild,
                args.nativeGroup,
            ).any { it != null }) ||
            operationId?.matches(identifier) == false ||
            (selecting && listOf(
                args.childId,
                args.currentChildId,
                args.groupId,
                args.profileId,
                args.profileRevision,
                args.runtimeAuthority,
            ).any { it?.matches(identifier) != true }) ||
            listOf(args.nativeGroup, args.nativeCurrentChild, args.nativeChild)
                .filterNotNull()
                .any { it.isEmpty() || it.length > 256 }
        ) {
            return failure(operationId, "invalid-request")
        }
        val native = if (selecting) {
            core.select(
                operationId = checkNotNull(operationId),
                runtimeAuthority = checkNotNull(args.runtimeAuthority),
                profileId = checkNotNull(args.profileId),
                profileRevision = checkNotNull(args.profileRevision),
                groupId = checkNotNull(args.groupId),
                currentChildId = checkNotNull(args.currentChildId),
                childId = checkNotNull(args.childId),
                nativeGroup = checkNotNull(args.nativeGroup),
                nativeCurrentChild = checkNotNull(args.nativeCurrentChild),
                nativeChild = checkNotNull(args.nativeChild),
            )
        } else {
            core.snapshot()
        }
        if (
            native.statusEnvelope == null || native.routesEnvelope == null
        ) {
            return failure(operationId, "malformed-response")
        }
        if (
            native.statusEnvelope.toByteArray().size > MAX_ENVELOPE_BYTES ||
            native.routesEnvelope.toByteArray().size > MAX_ENVELOPE_BYTES ||
            native.commandEnvelope?.toByteArray()?.size?.let { it > MAX_ENVELOPE_BYTES } == true
        ) {
            return failure(operationId, "response-too-large")
        }
        val commandFailure = when {
            !selecting -> null
            native.commandStatus == 0 && data(native.commandStatus, native.commandEnvelope) != null -> null
            native.commandStatus == 5 -> "conflict"
            native.commandStatus == 1 -> "invalid-request"
            else -> "native-failure"
        }
        if (commandFailure != null) return failure(operationId, commandFailure)
        val status = data(native.statusStatus, native.statusEnvelope)
            ?.takeIf(::validStatus)
            ?: return failure(operationId, "malformed-response")
        val routes = data(native.routesStatus, native.routesEnvelope)
            ?.takeIf(::validRoutes)
            ?: return failure(operationId, "malformed-response")
        return JSONObject()
            .put("contractVersion", 1)
            .put("failure", commandFailure)
            .put("operationId", operationId)
            .put("routes", routes)
            .put("status", status)
    }

    private fun data(status: Int, envelope: String?): JSONObject? = runCatching {
        if (status != 0 || envelope == null || envelope.toByteArray().size > MAX_ENVELOPE_BYTES) {
            return null
        }
        val root = JSONObject(envelope)
        requireKeys(root, setOf("abiVersion", "data"))
        require(root.getInt("abiVersion") == 1)
        root.getJSONObject("data")
    }.getOrNull()

    private fun failure(operationId: String?, failure: String): JSONObject = JSONObject()
        .put("contractVersion", 1)
        .put("failure", failure)
        .put("operationId", operationId)
        .put("routes", JSONObject().put("groups", JSONArray()).put("mode", "rule").put("truncated", false))
        .put("status", JSONObject()
            .put("configSha256", JSONObject.NULL)
            .put("eventSequence", "0")
            .put("loaded", false)
            .put("mode", "rule")
            .put("phase", "inactive")
            .put("sessionId", JSONObject.NULL))

    private fun requireKeys(value: JSONObject, expected: Set<String>) {
        val actual = mutableSetOf<String>()
        val keys = value.keys()
        while (keys.hasNext()) actual += keys.next()
        require(actual == expected)
    }

    private fun validStatus(value: JSONObject): Boolean = runCatching {
        requireKeys(value, setOf("configSha256", "eventSequence", "loaded", "mode", "phase", "sessionId"))
        val digest = value.optString("configSha256", "")
        require(value.isNull("configSha256") || digest.matches(Regex("^[a-f0-9]{64}$")))
        require(value.getString("eventSequence").matches(Regex("^(0|[1-9][0-9]*)$")))
        value.getBoolean("loaded")
        require(value.getString("mode") in setOf("rule", "global", "direct"))
        require(value.getString("phase") in setOf("inactive", "running"))
        require(value.isNull("sessionId") || value.getString("sessionId").matches(Regex("^[A-Za-z0-9._:-]{1,128}$")))
        true
    }.getOrDefault(false)

    private fun validRoutes(value: JSONObject): Boolean = runCatching {
        requireKeys(value, setOf("groups", "mode", "truncated"))
        require(value.getString("mode") in setOf("rule", "global", "direct"))
        value.getBoolean("truncated")
        val groups = value.getJSONArray("groups")
        require(groups.length() <= 512)
        repeat(groups.length()) { index ->
            val group = groups.getJSONObject(index)
            requireKeys(group, setOf("candidates", "name", "selected"))
            require(group.getString("name").length in 1..256)
            require(group.getString("selected").length in 1..256)
            val candidates = group.getJSONArray("candidates")
            require(candidates.length() <= 512)
            repeat(candidates.length()) { child ->
                require(candidates.getString(child).length in 1..256)
            }
        }
        true
    }.getOrDefault(false)
}
