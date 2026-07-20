package com.asuka109.mish.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
}
