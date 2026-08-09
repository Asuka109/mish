package com.asuka109.mish.vpn

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidPlatformFactsContractTest {
    @Test
    fun `generated golden contract owns every Kotlin wire field`() {
        val facts = MobilePlatformFacts(
            coreAbiVersion = 1,
            coreAvailability = "available",
            coreCommit = "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb",
            coreVersion = "v1.19.29",
            coreWrapperRevision = "mish-mobile-core-v1",
            factSequence = 7,
            notificationPermission = "required",
            observedAtMillis = 1_700_000_000_000,
            platformSessionId = "platform-session-1",
            vpnPermission = "required",
        )

        val encoded = facts.toJson()
        val golden = JSONObject(ANDROID_PLATFORM_FACTS_GOLDEN_JSON)

        assertEquals(golden.keySet(), encoded.keySet())
        assertTrue(golden.similar(encoded))
    }

    @Test
    fun `unknown enums malformed bounds and unsafe integers fail explicitly`() {
        val valid = MobilePlatformFacts(
            factSequence = 1,
            observedAtMillis = 1,
            platformSessionId = "platform-session-1",
        )

        assertThrows(IllegalStateException::class.java) {
            valid.copy(event = "future-event").toJson()
        }
        assertThrows(IllegalStateException::class.java) {
            valid.copy(protectedSocketCount = 2).toJson()
        }
        assertThrows(IllegalStateException::class.java) {
            valid.copy(factSequence = ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX + 1).toJson()
        }
        assertThrows(IllegalStateException::class.java) {
            valid.copy(platformSessionId = "private/path").toJson()
        }
    }
}
