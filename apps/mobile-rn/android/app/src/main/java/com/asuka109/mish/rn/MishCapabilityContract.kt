package com.asuka109.mish.rn

/**
 * Closed, effect-free capability model for the foundation build.
 *
 * The model is intentionally separate from the TurboModule adapter so unit tests
 * can replay bounded invocation/result transcripts without a React runtime.
 */
object MishCapabilityContract {
  const val CONTRACT_VERSION = 1
  const val MAX_REQUEST_ID_LENGTH = 64
  const val MAX_TRANSCRIPT_EVENTS = 32

  val capabilities =
      listOf("vpn", "tun", "core", "socket-protection", "foreground-service")

  enum class EffectKind {
    SNAPSHOT,
    REQUEST,
  }

  enum class ResultKind {
    UNAVAILABLE,
    INVALID_INPUT,
  }

  data class TranscriptEvent(
      val sequence: Int,
      val effect: EffectKind,
      val result: ResultKind,
  )

  data class Evaluation(val payload: String, val transcript: List<TranscriptEvent>) {
    init {
      require(transcript.size <= MAX_TRANSCRIPT_EVENTS) { "transcript-too-large" }
    }
  }

  private const val unavailableMessage =
      "Native platform effects are unavailable in this foundation build."

  fun snapshot(): Evaluation =
      Evaluation(
          payload =
              "{\"contractVersion\":1,\"state\":\"unavailable\",\"capabilities\":[\"vpn\",\"tun\",\"core\",\"socket-protection\",\"foreground-service\"],\"message\":\"$unavailableMessage\"}",
          transcript = listOf(TranscriptEvent(1, EffectKind.SNAPSHOT, ResultKind.UNAVAILABLE)),
      )

  fun request(capability: String, requestId: String): Evaluation {
    val validCapability = capabilities.contains(capability)
    val validRequestId =
        requestId.length in 1..MAX_REQUEST_ID_LENGTH &&
            requestId.matches(Regex("[A-Za-z0-9._:-]{1,64}"))
    if (!validCapability || !validRequestId) {
      return Evaluation(
          payload =
              "{\"contractVersion\":1,\"capability\":null,\"requestId\":null,\"state\":\"rejected\",\"reason\":\"invalid-input\",\"message\":\"Capability name or request identity is invalid.\"}",
          transcript = listOf(TranscriptEvent(1, EffectKind.REQUEST, ResultKind.INVALID_INPUT)),
      )
    }
    return Evaluation(
        payload =
            "{\"contractVersion\":1,\"capability\":\"${escape(capability)}\",\"requestId\":\"${escape(requestId)}\",\"state\":\"unavailable\",\"reason\":\"not-implemented\",\"message\":\"$unavailableMessage\"}",
        transcript = listOf(TranscriptEvent(1, EffectKind.REQUEST, ResultKind.UNAVAILABLE)),
    )
  }

  private fun escape(value: String): String = value.replace("\\", "\\\\").replace("\"", "\\\"")
}
