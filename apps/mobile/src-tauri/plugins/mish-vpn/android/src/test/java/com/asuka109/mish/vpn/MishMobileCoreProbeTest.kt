package com.asuka109.mish.vpn

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MishMobileCoreProbeTest {
    @Test
    fun `accepts an exact bounded v1 identity envelope`() {
        val identity = MishMobileCoreProbe.parseIdentity(
            """{"abiVersion":1,"data":{"abiVersion":1,"mihomoCommit":"e26714a181ac0e2fa803453c0a8e9a9ce94e31cb","mihomoVersion":"v1.19.29","wrapperRevision":"mish-mobile-core-v1"}}""",
            1,
        )

        assertEquals(1, identity?.abiVersion)
        assertEquals("v1.19.29", identity?.version)
        assertEquals("mish-mobile-core-v1", identity?.wrapperRevision)
    }

    @Test
    fun `rejects malformed errors and ABI mismatch`() {
        assertNull(MishMobileCoreProbe.parseIdentity("{}", 1))
        assertNull(
            MishMobileCoreProbe.parseIdentity(
                """{"abiVersion":1,"error":{"code":"failure","message":"failed"}}""",
                1,
            ),
        )
        assertNull(
            MishMobileCoreProbe.parseIdentity(
                """{"abiVersion":1,"data":{"abiVersion":1,"mihomoCommit":"e26714a","mihomoVersion":"v1.19.29","wrapperRevision":"mish-mobile-core-v1"}}""",
                2,
            ),
        )
    }

    @Test
    fun `parses only the bounded runtime result tuple`() {
        assertEquals(
            NativeRuntimeResult(NativeRuntimeCode.RUNNING, 0),
            MishMobileCoreProbe.parseRuntime(intArrayOf(0, 0)),
        )
        assertEquals(
            NativeRuntimeCode.MALFORMED_RESPONSE,
            MishMobileCoreProbe.parseRuntime(intArrayOf(0)).code,
        )
        assertEquals(
            NativeRuntimeCode.NATIVE_FAILED,
            MishMobileCoreProbe.parseRuntime(intArrayOf(99, -1)).code,
        )
    }

    @Test
    fun `accepts only the coordinator issued next effect for same operation cleanup`() {
        val active = CoreLifecycleAuthority("authority", 1, "start", 2, "1")

        assertEquals("2", active.nextEffect()?.effectIdentity)
        assertTrue(lifecycleAuthorityIsSuccessor(active.copy(effectIdentity = "2"), active))
        assertFalse(lifecycleAuthorityIsSuccessor(active.copy(effectIdentity = "1.cleanup"), active))
        assertFalse(lifecycleAuthorityIsSuccessor(active.copy(effectIdentity = "3"), active))
        assertFalse(lifecycleAuthorityIsSuccessor(active.copy(operationId = "foreign"), active))
        assertNull(active.copy(effectIdentity = ULong.MAX_VALUE.toString()).nextEffect())
    }

    @Test
    fun `round trips only a complete persisted lifecycle authority`() {
        val authority = CoreLifecycleAuthority("authority", 7, "start", 23, "1")

        assertEquals(authority, CoreLifecycleAuthority.fromJson(authority.toJson()))
        assertNull(
            CoreLifecycleAuthority.fromJson(
                JSONObject(authority.toJson().toString()).put("unexpected", true),
            ),
        )
        assertNull(
            CoreLifecycleAuthority.fromJson(
                JSONObject(authority.toJson().toString()).put("effectIdentity", "0"),
            ),
        )
        assertNull(
            CoreLifecycleAuthority.fromJson(
                JSONObject(authority.toJson().toString()).put("admittedRevision", Long.MAX_VALUE),
            ),
        )
    }
}
