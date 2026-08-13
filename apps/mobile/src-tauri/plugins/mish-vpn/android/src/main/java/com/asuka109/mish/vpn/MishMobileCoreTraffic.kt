package com.asuka109.mish.vpn

import org.json.JSONObject

/**
 * Closed Kotlin command adapter for Traffic. The production plugin and the
 * emulator acceptance both cross this path; only [MobileCoreTrafficAdapter]
 * is replaced by a deterministic native-effect fixture in instrumentation.
 */
internal object MobileCoreTrafficCommandAdapter {
    private val closedIdentifier = Regex("^[A-Za-z0-9._-]{1,128}$")
    private val decimalIdentifier = Regex("^[0-9]{1,20}$")

    fun snapshot(core: MobileCoreTrafficAdapter): JSONObject =
        core.snapshotTraffic() ?: MishMobileCoreProbe.emptyTrafficSnapshot()

    fun close(core: MobileCoreTrafficAdapter, args: CloseTrafficConnectionArgs): JSONObject {
        val result = if (
            args.connectionId.matches(closedIdentifier) &&
            args.eventSequence.matches(decimalIdentifier) &&
            args.sessionId.matches(closedIdentifier)
        ) {
            core.closeTrafficConnection(args.connectionId, args.eventSequence, args.sessionId)
        } else {
            NativeTrafficCloseResult("invalid-request", snapshot(core))
        }
        return JSONObject()
            .put("failure", result.failure ?: JSONObject.NULL)
            .put("snapshot", result.snapshot)
    }
}
