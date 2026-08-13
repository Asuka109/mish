package com.asuka109.mish.vpn

import app.tauri.plugin.JSObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Android owns only the fixed HTTPS effect. Shared Rust owns run identity,
 * history, cancellation semantics, timeout classification, and replacement.
 */
internal class MishFixedDiagnosticEffect(
    private val transport: MishFixedDiagnosticTransport = FixedHttpDiagnosticTransport(),
) {
    private val cancellations = ConcurrentHashMap<String, MishFixedDiagnosticCancellation>()

    fun run(runId: String): JSObject {
        if (!runId.matches(IDENTIFIER_PATTERN)) return failure("invalid-run", "platform-failure")
        val cancellation = MishFixedDiagnosticCancellation()
        if (cancellations.putIfAbsent(runId, cancellation) != null) {
            return failure(runId, "platform-failure")
        }
        try {
            if (cancellation.isCancelled()) return cancelled(runId)
            return when (transport.execute(cancellation)) {
                MishFixedDiagnosticTransportResult.COMPLETED -> success(runId)
                MishFixedDiagnosticTransportResult.CANCELLED -> cancelled(runId)
                MishFixedDiagnosticTransportResult.FIXED_TARGET_UNAVAILABLE ->
                    failure(runId, "fixed-target-unavailable")
                MishFixedDiagnosticTransportResult.NETWORK_UNAVAILABLE ->
                    failure(runId, "network-unavailable")
                MishFixedDiagnosticTransportResult.PLATFORM_FAILURE ->
                    failure(runId, "platform-failure")
                MishFixedDiagnosticTransportResult.TIMED_OUT ->
                    failure(runId, "timeout", "timed-out")
            }
        } finally {
            cancellations.remove(runId, cancellation)
        }
    }

    fun cancel(runId: String): Boolean = cancellations[runId]?.let {
        it.cancel()
        true
    } ?: false

    fun cancelAll() {
        cancellations.values.forEach { it.cancel() }
    }

    private fun success(runId: String): JSObject = result(
        runId,
        "completed",
        null,
        listOf(
            check("active-network", "passed"),
            check("https-handshake", "passed"),
            check("http204", "passed"),
        ),
    )

    private fun cancelled(runId: String): JSObject = result(
        runId,
        "cancelled",
        "cancelled",
        emptyList(),
    )

    private fun failure(runId: String, failure: String, outcome: String = "failed"): JSObject =
        result(
            runId,
            outcome,
            failure,
            listOf(
                check("active-network", if (failure == "network-unavailable") "failed" else "passed"),
                check("https-handshake", "failed"),
                check("http204", "skipped"),
            ),
        )

    private fun result(
        runId: String,
        outcome: String,
        failure: String?,
        checks: List<JSObject>,
    ): JSObject = JSObject()
        .put("checks", org.json.JSONArray(checks))
        .put("failure", failure)
        .put("outcome", outcome)
        .put("runId", runId)

    private fun check(kind: String, outcome: String): JSObject = JSObject()
        .put("kind", kind)
        .put("outcome", outcome)

    private companion object {
        val IDENTIFIER_PATTERN = Regex("^[A-Za-z0-9._-]{1,128}$")
    }
}

internal fun interface MishFixedDiagnosticTransport {
    fun execute(cancellation: MishFixedDiagnosticCancellation): MishFixedDiagnosticTransportResult
}

internal class MishFixedDiagnosticCancellation {
    private val cancelled = AtomicBoolean(false)
    private val connection = AtomicReference<HttpURLConnection?>(null)

    fun cancel() {
        cancelled.set(true)
        connection.getAndSet(null)?.disconnect()
    }

    fun install(connection: HttpURLConnection): Boolean {
        if (cancelled.get()) return false
        this.connection.set(connection)
        if (!cancelled.get()) return true
        this.connection.getAndSet(null)?.disconnect()
        return false
    }

    fun isCancelled(): Boolean = cancelled.get()

    fun release(connection: HttpURLConnection) {
        this.connection.compareAndSet(connection, null)
    }
}

internal enum class MishFixedDiagnosticTransportResult {
    CANCELLED,
    COMPLETED,
    FIXED_TARGET_UNAVAILABLE,
    NETWORK_UNAVAILABLE,
    PLATFORM_FAILURE,
    TIMED_OUT,
}

private class FixedHttpDiagnosticTransport : MishFixedDiagnosticTransport {
    override fun execute(
        cancellation: MishFixedDiagnosticCancellation,
    ): MishFixedDiagnosticTransportResult {
        val connection = runCatching {
            URL(FIXED_TARGET).openConnection() as HttpURLConnection
        }.getOrNull() ?: return MishFixedDiagnosticTransportResult.PLATFORM_FAILURE
        if (!cancellation.install(connection)) {
            connection.disconnect()
            return MishFixedDiagnosticTransportResult.CANCELLED
        }
        return try {
            connection.connectTimeout = TIMEOUT_MILLIS
            connection.readTimeout = TIMEOUT_MILLIS
            connection.instanceFollowRedirects = false
            connection.requestMethod = "GET"
            connection.useCaches = false
            connection.connect()
            if (cancellation.isCancelled()) return MishFixedDiagnosticTransportResult.CANCELLED
            if (connection.responseCode == 204) {
                MishFixedDiagnosticTransportResult.COMPLETED
            } else {
                MishFixedDiagnosticTransportResult.FIXED_TARGET_UNAVAILABLE
            }
        } catch (_: java.net.SocketTimeoutException) {
            MishFixedDiagnosticTransportResult.TIMED_OUT
        } catch (_: Throwable) {
            if (cancellation.isCancelled()) {
                MishFixedDiagnosticTransportResult.CANCELLED
            } else {
                MishFixedDiagnosticTransportResult.NETWORK_UNAVAILABLE
            }
        } finally {
            cancellation.release(connection)
            connection.disconnect()
        }
    }

    private companion object {
        const val FIXED_TARGET = "https://www.gstatic.com/generate_204"
        const val TIMEOUT_MILLIS = 5_000
    }
}

internal class FixedDiagnosticArgs {
    var runId: String = ""
}
