package com.asuka109.mish.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class MishFixedDiagnosticTest {
    @Test
    fun `malformed run identity fails without selecting target or timeout`() {
        val result = MishFixedDiagnosticEffect().run("https://private.invalid/?token=secret")
        assertEquals("platform-failure", result.getString("failure"))
        assertEquals("failed", result.getString("outcome"))
        assertFalse(result.toString().contains("private.invalid"))
        assertFalse(result.toString().contains("token"))
    }

    @Test
    fun `unknown cancellation is rejected without retaining history`() {
        assertFalse(MishFixedDiagnosticEffect().cancel("unknown-run"))
    }

    @Test
    fun `fixed effect publishes closed success and timeout results without real network`() {
        val success = MishFixedDiagnosticEffect {
            MishFixedDiagnosticTransportResult.COMPLETED
        }.run("run-1")
        val timeout = MishFixedDiagnosticEffect {
            MishFixedDiagnosticTransportResult.TIMED_OUT
        }.run("run-2")

        assertEquals("completed", success.getString("outcome"))
        assertEquals(3, success.getJSONArray("checks").length())
        assertEquals("timed-out", timeout.getString("outcome"))
        assertEquals("timeout", timeout.getString("failure"))
    }

    @Test
    fun `cancellation is bounded to the matching in-flight run`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
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
        val worker = thread { result = effect.run("run-1") }
        assertEquals(true, entered.await(1, TimeUnit.SECONDS))
        assertFalse(effect.cancel("run-2"))
        assertEquals(true, effect.cancel("run-1"))
        release.countDown()
        worker.join(1_000)
        assertEquals("cancelled", result?.getString("outcome"))
    }
}
