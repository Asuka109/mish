package com.asuka109.mish.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileCoreProvenanceAdversarialTest {
    @Test
    fun `manifest adversarial matrix fails closed before every runtime effect`() {
        val exact = exactManifestJson()
        val cases = listOf(
            "missing manifest" to null,
            "malformed manifest" to "{",
            "unknown manifest fact" to exact.replaceFirst("{", "{\"privatePath\":\"/private/example\","),
            "duplicate manifest fact" to exact.replaceFirst(
                "\"schemaVersion\":2",
                "\"schemaVersion\":2,\"schemaVersion\":2",
            ),
            "missing manifest fact" to exact.replace(
                ",\"sourceVersion\":\"${MobileCoreAdmissionPolicy.PINNED_SOURCE_VERSION}\"",
                "",
            ),
            "malformed manifest fact" to exact.replace("\"abiVersion\":1", "\"abiVersion\":\"1\""),
            "unknown artifact fact" to exact.replaceFirst("\"sha256\":", "\"privatePath\":\"/private/example\",\"sha256\":"),
            "duplicate artifact fact" to exact.replaceFirst("\"abi\":\"arm64-v8a\"", "\"abi\":\"arm64-v8a\",\"abi\":\"arm64-v8a\""),
        )

        cases.forEach { (name, manifest) ->
            assertRejectedBeforeEffects(name, MutableAdmissionSource(manifestText = manifest))
        }
    }

    @Test
    fun `ABI and artifact adversarial matrix fails closed before every runtime effect`() {
        val cases = listOf(
            "unsupported runtime ABI" to MutableAdmissionSource(runtimeAbiValue = "armeabi-v7a"),
            "missing runtime ABI" to MutableAdmissionSource(runtimeAbiValue = null),
            "manifest ABI mismatch" to MutableAdmissionSource(
                manifestText = exactManifestJson().replace("x86_64", "armeabi-v7a"),
            ),
            "duplicate manifest ABI" to MutableAdmissionSource(
                manifestText = exactManifestJson().replace("x86_64", "arm64-v8a"),
            ),
            "missing artifact" to MutableAdmissionSource(
                artifactObservations = listOf(artifactFailure(MobileCoreAdmissionFailure.ARTIFACT_MISSING)),
            ),
            "truncated artifact" to MutableAdmissionSource(
                artifactObservations = listOf(artifactFailure(MobileCoreAdmissionFailure.ARTIFACT_TRUNCATED)),
            ),
            "oversized artifact" to MutableAdmissionSource(
                artifactObservations = listOf(artifactFailure(MobileCoreAdmissionFailure.ARTIFACT_OVERSIZED)),
            ),
            "replaced artifact at first observation" to MutableAdmissionSource(
                artifactObservations = listOf(artifactFailure(MobileCoreAdmissionFailure.ARTIFACT_REPLACED)),
            ),
            "artifact digest mismatch" to MutableAdmissionSource(
                artifactObservations = listOf(artifactDigest("c")),
            ),
        )

        cases.forEach { (name, source) -> assertRejectedBeforeEffects(name, source) }
    }

    @Test
    fun `signer adversarial matrix fails closed before every runtime effect`() {
        val expected = expectedSignature()
        val cases = listOf(
            "missing signer" to null,
            "multiple signers" to observePackageSigners(listOf("one".toByteArray(), "two".toByteArray())),
            "malformed empty signer" to observePackageSigners(listOf(ByteArray(0))),
            "oversized signer" to observePackageSigners(listOf(ByteArray(MOBILE_CORE_ADMISSION_MAX_SIGNATURE_BYTES + 1))),
            "unverified signer" to expected.copy(verified = false),
            "malformed signer digest" to MobileCoreSignatureEvidence("not-a-digest", true),
            "mismatched signer" to MobileCoreSignatureEvidence("f".repeat(64), true),
        )

        cases.forEach { (name, signature) ->
            assertRejectedBeforeEffects(name, MutableAdmissionSource(signature = signature))
        }

        assertNull(observePackageSigners(emptyList()))
        assertNull(observePackageSigners(listOf("one".toByteArray(), "two".toByteArray())))
        assertNull(observePackageSigners(listOf(ByteArray(0))))
        assertNull(observePackageSigners(listOf(ByteArray(MOBILE_CORE_ADMISSION_MAX_SIGNATURE_BYTES + 1))))
    }

    @Test
    fun `real probe rejection prevents shim load and native calls`() {
        var shimLoads = 0
        val rejection = MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.ARTIFACT_REPLACED)
        val probe = MishMobileCoreProbe(
            admissionReader = { rejection },
            shimLoader = { shimLoads += 1; true },
        )

        assertEquals(rejection, probe.admission())
        assertNull(probe.inspect())
        assertEquals(NativeValidationCode.CORE_UNAVAILABLE, probe.validate(byteArrayOf(1), "a".repeat(64)).code)
        assertEquals(NativeLoadCode.CORE_UNAVAILABLE, probe.load(byteArrayOf(1), "a".repeat(64), false).code)
        assertEquals(NativeInspectionCode.NATIVE_FAILED, probe.inspectLoaded("a".repeat(64)).code)
        assertEquals(NativeRuntimeCode.CORE_UNAVAILABLE, probe.inspectRuntime(null).code)
        assertEquals(0, shimLoads)
    }

    @Test
    fun `occurrence bounded replacement at protected use boundary rejects before JNI and runtime effects`() {
        val source = MutableAdmissionSource(
            artifactObservations = listOf(artifactDigest("a"), artifactDigest("c")),
        )
        val admission = MobileCoreArtifactAdmission(source)

        val result = admission.admit()

        assertFalse(result.admitted)
        assertEquals(MobileCoreAdmissionFailure.ARTIFACT_REPLACED, result.failure)
        assertEquals(2, source.artifactObservationCount)
        assertEquals(
            MobileCoreAdmissionBoundaryInvocation(
                MobileCoreAdmissionBoundaryEffect.PROTECTED_USE_RECHECK,
                MobileCoreAdmissionBoundaryResult.REPLACED,
            ),
            admission.recentBoundaryInvocations().last(),
        )
        assertEveryRuntimeEffectIsZero(result)
    }

    @Test
    fun `closed boundary transcript is bounded and contains no private payload shape`() {
        val admission = MobileCoreArtifactAdmission(MutableAdmissionSource())

        repeat(20) { assertTrue(admission.admit().admitted) }

        val transcript = admission.recentBoundaryInvocations()
        assertEquals(16, transcript.size)
        val encoded = transcript.joinToString("|") { "${it.effect.name}:${it.result.name}" }
        for (forbidden in listOf("/private/", "certificate", "credential", "raw", "config", "output")) {
            assertFalse(encoded.lowercase().contains(forbidden))
        }
    }
}

private fun assertRejectedBeforeEffects(name: String, source: MutableAdmissionSource) {
    val admission = MobileCoreArtifactAdmission(source)
    val result = admission.admit()

    assertFalse("$name must reject", result.admitted)
    assertEveryRuntimeEffectIsZero(result)
    assertTrue("$name must record a closed boundary invocation", admission.recentBoundaryInvocations().isNotEmpty())
}

private fun assertEveryRuntimeEffectIsZero(rejection: MobileCoreAdmissionResult) {
    var jniLoads = 0
    var validates = 0
    var loads = 0
    var starts = 0
    var inspections = 0
    var vpnTunEffects = 0
    val counters = mapOf(
        MobileCoreEffectOperation.INSPECT to { inspections += 1 },
        MobileCoreEffectOperation.VALIDATE to { validates += 1 },
        MobileCoreEffectOperation.LOAD to { loads += 1 },
        MobileCoreEffectOperation.INSPECT_LOADED to { inspections += 1 },
        MobileCoreEffectOperation.START to { starts += 1; vpnTunEffects += 1 },
        MobileCoreEffectOperation.STOP to { vpnTunEffects += 1 },
        MobileCoreEffectOperation.INSPECT_RUNTIME to { inspections += 1 },
    )
    counters.forEach { (operation, effect) ->
        MobileCoreAdmissionGate(admit = { rejection }).invoke(operation, rejected = {}, effect = effect)
    }
    MobileCoreAdmissionGate(admit = { rejection }).invoke(
        MobileCoreEffectOperation.ADMISSION,
        rejected = {},
        effect = { jniLoads += 1 },
    )

    assertEquals(0, jniLoads)
    assertEquals(0, validates)
    assertEquals(0, loads)
    assertEquals(0, starts)
    assertEquals(0, inspections)
    assertEquals(0, vpnTunEffects)
}

private class MutableAdmissionSource(
    private val manifestText: String? = exactManifestJson(),
    private val runtimeAbiValue: String? = "arm64-v8a",
    private val artifactObservations: List<MobileCoreArtifactObservation> = listOf(artifactDigest("a")),
    private val signature: MobileCoreSignatureEvidence? = expectedSignature(),
) : MobileCoreAdmissionSource {
    var artifactObservationCount = 0
        private set

    override fun readManifest(): String? = manifestText

    override fun runtimeAbi(): String? = runtimeAbiValue

    override fun observeArtifact(): MobileCoreArtifactObservation {
        val occurrence = artifactObservationCount++
        return artifactObservations.getOrElse(occurrence) { artifactObservations.last() }
    }

    override fun observeSignature(): MobileCoreSignatureEvidence? = signature
}

private fun artifactDigest(prefix: String) = MobileCoreArtifactObservation(digestSha256 = prefix.repeat(64))

private fun artifactFailure(failure: MobileCoreAdmissionFailure) = MobileCoreArtifactObservation(failure = failure)

private fun expectedSignature() = MobileCoreSignatureEvidence(
    fingerprintSha256 = MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256,
    verified = true,
)

private fun exactManifestJson(): String =
    """{"schemaVersion":2,"abiVersion":1,"sourceCommit":"${MobileCoreAdmissionPolicy.PINNED_SOURCE_COMMIT}","sourceVersion":"${MobileCoreAdmissionPolicy.PINNED_SOURCE_VERSION}","wrapperRevision":"${MobileCoreAdmissionPolicy.PINNED_WRAPPER_REVISION}","wrapperContractVersion":1,"artifacts":[{"abi":"arm64-v8a","sha256":"${"a".repeat(64)}"},{"abi":"x86_64","sha256":"${"b".repeat(64)}"}],"signatureScheme":"$MOBILE_CORE_ADMISSION_SIGNATURE_SCHEME","signatureVerification":"$MOBILE_CORE_ADMISSION_SIGNATURE_VERIFICATION","signerSha256":"$MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256"}"""
