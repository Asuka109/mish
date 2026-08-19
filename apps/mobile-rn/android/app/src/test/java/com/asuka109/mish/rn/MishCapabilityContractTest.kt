package com.asuka109.mish.rn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class MishCapabilityContractTest {
  @Test
  fun snapshotIsUnavailableAndBounded() {
    val evaluation = MishCapabilityContract.snapshot()

    assertTrue(evaluation.payload.contains("\"state\":\"unavailable\""))
    assertEquals(1, evaluation.transcript.size)
    assertEquals(MishCapabilityContract.ResultKind.UNAVAILABLE, evaluation.transcript.single().result)
    assertTrue(evaluation.transcript.size <= MishCapabilityContract.MAX_TRANSCRIPT_EVENTS)
  }

  @Test
  fun knownCapabilityDoesNotClaimAnEffect() {
    val evaluation = MishCapabilityContract.request("vpn", "test-1")

    assertTrue(evaluation.payload.contains("\"reason\":\"not-implemented\""))
    assertFalse(evaluation.payload.contains("running"))
    assertEquals(MishCapabilityContract.ResultKind.UNAVAILABLE, evaluation.transcript.single().result)
  }

  @Test
  fun unknownCapabilityAndUnboundedIdentityFailClosed() {
    val unknown = MishCapabilityContract.request("arbitrary-effect", "test-1")
    val oversized = MishCapabilityContract.request("vpn", "x".repeat(65))

    assertTrue(unknown.payload.contains("\"reason\":\"invalid-input\""))
    assertTrue(oversized.payload.contains("\"reason\":\"invalid-input\""))
    assertEquals(MishCapabilityContract.ResultKind.INVALID_INPUT, unknown.transcript.single().result)
    assertEquals(MishCapabilityContract.ResultKind.INVALID_INPUT, oversized.transcript.single().result)
  }

  @Test
  fun transcriptCapacityIsEnforced() {
    val event =
        MishCapabilityContract.TranscriptEvent(
            1,
            MishCapabilityContract.EffectKind.REQUEST,
            MishCapabilityContract.ResultKind.UNAVAILABLE,
        )

    assertThrows(IllegalArgumentException::class.java) {
      MishCapabilityContract.Evaluation(
          payload = "{}",
          transcript = List(MishCapabilityContract.MAX_TRANSCRIPT_EVENTS + 1) { event },
      )
    }
  }
}
