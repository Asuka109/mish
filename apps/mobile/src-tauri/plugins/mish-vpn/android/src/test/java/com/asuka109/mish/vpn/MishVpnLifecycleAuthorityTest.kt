package com.asuka109.mish.vpn

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MishVpnLifecycleAuthorityTest {
    @Test
    fun `authority is persisted before foreground or owned effects`() {
        val authority = authority("1")
        val transcript = BoundedLifecycleTranscript()

        assertTrue(lifecycleAuthorityMatchesOrIsSuccessor(authority, null))
        val persisted = authority
        transcript.record(EffectKind.AUTHORITY_PERSISTED)
        check(persisted == authority) { "authority must be durable before effects" }
        transcript.record(EffectKind.FOREGROUND)
        transcript.record(EffectKind.TUN)
        transcript.record(EffectKind.CORE)

        assertEquals(
            listOf(
                EffectKind.AUTHORITY_PERSISTED,
                EffectKind.FOREGROUND,
                EffectKind.TUN,
                EffectKind.CORE,
            ),
            transcript.events,
        )
    }

    @Test
    fun `replacement accepts only the Rust successor and rejects stale callbacks`() {
        val first = authority("1")
        val replacement = first.copy(scopeEpoch = 2, admittedRevision = 1, effectIdentity = "1")
        val stale = first.copy(effectIdentity = "0")
        val skipped = first.copy(effectIdentity = "3")

        assertTrue(lifecycleAuthorityIsSuccessor(replacement, first))
        assertFalse(lifecycleAuthorityIsSuccessor(stale, first))
        assertFalse(lifecycleAuthorityIsSuccessor(skipped, first))
        assertTrue(lifecycleAuthorityMatchesOrIsSuccessor(first, first))
    }

    @Test
    fun `recreation retains complete authority while malformed or foreign records fail closed`() {
        val original = MishVpnRecoveryRecord("service-1", authority("7"))
        val restored = MishVpnRecoveryRecord.fromJson(JSONObject(original.toJson().toString()))

        assertNotNull(restored)
        assertEquals(original, restored)
        assertFalse(
            MishVpnRecoveryRecord.fromJson(
                original.toJson().put("serviceInstanceId", "private/path"),
            ) != null,
        )
        assertFalse(
            lifecycleAuthorityIsSuccessor(
                authority("8").copy(machineAuthority = "foreign-authority"),
                original.lifecycleAuthority,
            ),
        )
    }

    @Test
    fun `authority bounds prevent unsafe effect identities from reaching JNI`() {
        assertTrue(authority(ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX.toString()).isValid())
        assertFalse(authority((ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX + 1).toString()).isValid())
        assertFalse(authority("18446744073709551615").isValid())
        assertEquals(null, authority(ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX.toString()).nextEffect())
    }

    private fun authority(effectIdentity: String): CoreLifecycleAuthority = CoreLifecycleAuthority(
        machineAuthority = "vpn-authority-1",
        scopeEpoch = 1,
        operationId = "operation-1",
        admittedRevision = 1,
        effectIdentity = effectIdentity,
    )

    private enum class EffectKind {
        AUTHORITY_PERSISTED,
        FOREGROUND,
        TUN,
        CORE,
    }

    private class BoundedLifecycleTranscript {
        private val mutableEvents = mutableListOf<EffectKind>()
        val events: List<EffectKind>
            get() = mutableEvents.toList()

        fun record(effect: EffectKind) {
            check(mutableEvents.size < 16) { "lifecycle transcript overflow" }
            mutableEvents += effect
        }
    }
}
