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
            """{"abiVersion":1,"data":{"abiVersion":1,"goVersion":"go1.26.0","mihomoCommit":"e26714a181ac0e2fa803453c0a8e9a9ce94e31cb","mihomoVersion":"v1.19.29","wrapperRevision":"mish-mobile-core-v1"}}""",
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
                """{"abiVersion":1,"data":{"abiVersion":1,"goVersion":"go1.26.0","mihomoCommit":"e26714a","mihomoVersion":"v1.19.29","wrapperRevision":"mish-mobile-core-v1"}}""",
                2,
            ),
        )
    }

    @Test
    fun `admits only the complete pinned provenance and verified package signature`() {
        val manifest = admissionManifest()
        val admitted = MobileCoreAdmissionPolicy.evaluate(
            manifest = manifest,
            runtimeAbi = "arm64-v8a",
            observedArtifactDigest = "a".repeat(64),
            signature = MobileCoreSignatureEvidence(
                fingerprintSha256 = MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256,
                verified = true,
            ),
        )

        assertTrue(admitted.admitted)
        assertEquals("arm64-v8a", admitted.artifactAbi)
        assertEquals("a".repeat(64), admitted.artifactDigest)
    }

    @Test
    fun `rejects provenance drift before any native admission`() {
        val cases = listOf(
            MobileCoreAdmissionPolicy.PINNED_SOURCE_COMMIT to MobileCoreAdmissionFailure.SOURCE_MISMATCH,
            MobileCoreAdmissionPolicy.PINNED_SOURCE_VERSION to MobileCoreAdmissionFailure.VERSION_MISMATCH,
            MobileCoreAdmissionPolicy.PINNED_WRAPPER_REVISION to MobileCoreAdmissionFailure.WRAPPER_MISMATCH,
        )

        cases.forEachIndexed { index, (_, expected) ->
            val drifted = admissionManifest().let { manifest ->
                when (index) {
                    0 -> manifest.copy(sourceCommit = "f".repeat(40))
                    1 -> manifest.copy(sourceVersion = "v9.9.9")
                    else -> manifest.copy(wrapperRevision = "mish-mobile-core-v2")
                }
            }
            val result = MobileCoreAdmissionPolicy.evaluate(
                drifted,
                "arm64-v8a",
                "a".repeat(64),
                MobileCoreSignatureEvidence(MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256, true),
            )
            assertFalse(result.admitted)
            assertEquals(expected, result.failure)
        }
    }

    @Test
    fun `rejects ABI digest and signature mismatch before runtime effects`() {
        val manifest = admissionManifest()
        val inputs = listOf(
            Triple("mips", "a".repeat(64), MobileCoreSignatureEvidence(MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256, true)) to MobileCoreAdmissionFailure.ABI_MISMATCH,
            Triple("arm64-v8a", "b".repeat(64), MobileCoreSignatureEvidence(MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256, true)) to MobileCoreAdmissionFailure.ARTIFACT_DIGEST_MISMATCH,
            Triple("arm64-v8a", "a".repeat(64), MobileCoreSignatureEvidence(MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256, false)) to MobileCoreAdmissionFailure.SIGNATURE_UNVERIFIED,
            Triple("arm64-v8a", "a".repeat(64), MobileCoreSignatureEvidence("8f285b7d4829e694b5e8c11590807b4cf1a06c417fca4a9f7cbae9e4ee0fa5d0", true)) to MobileCoreAdmissionFailure.SIGNER_FINGERPRINT_MISMATCH,
        )

        inputs.forEach { (input, expected) ->
            val result = MobileCoreAdmissionPolicy.evaluate(manifest, input.first, input.second, input.third)
            assertFalse(result.admitted)
            assertEquals(expected, result.failure)
        }
    }

    @Test
    fun `rejects missing or unverifiable required admission facts`() {
        val manifest = admissionManifest()
        val cases = listOf(
            Triple(null, "a".repeat(64), MobileCoreSignatureEvidence(MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256, true)) to MobileCoreAdmissionFailure.MANIFEST_MALFORMED,
            Triple(manifest, null, MobileCoreSignatureEvidence(MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256, true)) to MobileCoreAdmissionFailure.ARTIFACT_DIGEST_MISMATCH,
            Triple(manifest, "a".repeat(64), null) to MobileCoreAdmissionFailure.SIGNATURE_MISSING,
            Triple(manifest.copy(artifacts = listOf(manifest.artifacts.first())), "a".repeat(64), MobileCoreSignatureEvidence(MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256, true)) to MobileCoreAdmissionFailure.ABI_MISMATCH,
        )

        cases.forEach { (input, expected) ->
            val result = MobileCoreAdmissionPolicy.evaluate(
                manifest = input.first,
                runtimeAbi = "arm64-v8a",
                observedArtifactDigest = input.second,
                signature = input.third,
            )
            assertFalse(result.admitted)
            assertEquals(expected, result.failure)
        }
    }

    @Test
    fun `records a closed rejection and never invokes the native effect`() {
        val invocations = mutableListOf<MobileCoreAdmissionInvocation>()
        var effects = 0
        val gate = MobileCoreAdmissionGate(
            admit = {
                MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.SOURCE_MISMATCH)
            },
            observer = invocations::add,
        )

        val result = gate.invoke(
            operation = MobileCoreEffectOperation.START,
            rejected = { it },
            effect = {
                effects += 1
                MobileCoreAdmissionResult.accepted("arm64-v8a", "a".repeat(64))
            },
        )

        assertFalse(result.admitted)
        assertEquals(MobileCoreAdmissionFailure.SOURCE_MISMATCH, result.failure)
        assertEquals(0, effects)
        assertEquals(
            listOf(MobileCoreAdmissionInvocation(MobileCoreEffectOperation.START, result)),
            invocations,
        )
        assertEquals(invocations, gate.recentInvocations())
    }

    @Test
    fun `rejects a differently signed APK before native effect`() {
        val foreign = MobileCoreSignatureEvidence(
            fingerprintSha256 = "8f285b7d4829e694b5e8c11590807b4cf1a06c417fca4a9f7cbae9e4ee0fa5d0",
            verified = true,
        )
        val admission = MobileCoreAdmissionPolicy.evaluate(
            admissionManifest(),
            "arm64-v8a",
            "a".repeat(64),
            foreign,
        )
        var effects = 0
        val result = MobileCoreAdmissionGate(admit = { admission }).invoke(
            operation = MobileCoreEffectOperation.START,
            rejected = { it },
            effect = {
                effects += 1
                MobileCoreAdmissionResult.accepted("arm64-v8a", "a".repeat(64))
            },
        )

        assertFalse(result.admitted)
        assertEquals(MobileCoreAdmissionFailure.SIGNER_FINGERPRINT_MISMATCH, result.failure)
        assertEquals(0, effects)
    }

    @Test
    fun `observes the checked in debug certificate as one bounded signer fingerprint`() {
        val fixtureCertificate =
            javaClass.getResourceAsStream("/mish-fixture-debug.cer")?.use { it.readBytes() }
                ?: error("missing synthetic debug certificate fixture")
        val expected = observePackageSigners(
            listOf(fixtureCertificate),
        )
        assertEquals(MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256, expected?.fingerprintSha256)
        assertTrue(expected?.verified == true)
        assertNull(observePackageSigners(emptyList()))
        assertNull(
            observePackageSigners(
                listOf(
                    javaClass.getResourceAsStream("/mish-fixture-debug.cer")!!.use { it.readBytes() },
                    "foreign".toByteArray(),
                ),
            ),
        )
        assertNull(observePackageSigners(listOf(ByteArray(0))))
        assertNull(observePackageSigners(listOf(ByteArray(MOBILE_CORE_ADMISSION_MAX_SIGNATURE_BYTES + 1))))
    }

    @Test
    fun `rejects malformed signer fingerprints`() {
        listOf(
            "not-a-digest",
            "8f285b7d4829e694b5e8c11590807b4cf1a06c417fca4a9f7cbae9e4ee0fa5d0",
        )
            .forEach { signerSha256 ->
                val result = MobileCoreAdmissionPolicy.evaluate(
                    admissionManifest().copy(signerSha256 = signerSha256),
                    "arm64-v8a",
                    "a".repeat(64),
                    MobileCoreSignatureEvidence(MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256, true),
                )
                assertFalse(result.admitted)
                assertEquals(MobileCoreAdmissionFailure.SIGNER_FINGERPRINT_MISMATCH, result.failure)
            }
        val runtimeMalformed = MobileCoreAdmissionPolicy.evaluate(
            admissionManifest(),
            "arm64-v8a",
            "a".repeat(64),
            MobileCoreSignatureEvidence("NOT-A-LOWERCASE-DIGEST", true),
        )
        assertFalse(runtimeMalformed.admitted)
        assertEquals(MobileCoreAdmissionFailure.SIGNER_FINGERPRINT_MISMATCH, runtimeMalformed.failure)
    }

    @Test
    fun `rejects malformed manifest fields and unknown artifact keys`() {
        assertNull(
            MobileCoreAdmissionManifest.parse(
                admissionManifestJson().replace("\"schemaVersion\":2", "\"schemaVersion\":3"),
            ),
        )
        assertNull(
            MobileCoreAdmissionManifest.parse(
                admissionManifestJson().replace("\"abi\":\"arm64-v8a\"", "\"abi\":\"mips\",\"unexpected\":true"),
            ),
        )
        assertNull(
            MobileCoreAdmissionManifest.parse(
                admissionManifestJson().replace(
                    ",\"signerSha256\":\"$MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256\"",
                    "",
                ),
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

private fun admissionManifest(): MobileCoreAdmissionManifest = MobileCoreAdmissionManifest(
    schemaVersion = 2,
    abiVersion = 1,
    sourceCommit = MobileCoreAdmissionPolicy.PINNED_SOURCE_COMMIT,
    sourceVersion = MobileCoreAdmissionPolicy.PINNED_SOURCE_VERSION,
    wrapperRevision = MobileCoreAdmissionPolicy.PINNED_WRAPPER_REVISION,
    wrapperContractVersion = 1,
    artifacts = listOf(
        MobileCoreAdmissionArtifact("arm64-v8a", "a".repeat(64)),
        MobileCoreAdmissionArtifact("x86_64", "b".repeat(64)),
    ),
    signatureScheme = MOBILE_CORE_ADMISSION_SIGNATURE_SCHEME,
    signatureVerification = MOBILE_CORE_ADMISSION_SIGNATURE_VERIFICATION,
    signerSha256 = MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256,
)

private fun admissionManifestJson(): String =
    """{"schemaVersion":2,"abiVersion":1,"sourceCommit":"${MobileCoreAdmissionPolicy.PINNED_SOURCE_COMMIT}","sourceVersion":"${MobileCoreAdmissionPolicy.PINNED_SOURCE_VERSION}","wrapperRevision":"${MobileCoreAdmissionPolicy.PINNED_WRAPPER_REVISION}","wrapperContractVersion":1,"artifacts":[{"abi":"arm64-v8a","sha256":"${"a".repeat(64)}"},{"abi":"x86_64","sha256":"${"b".repeat(64)}"}],"signatureScheme":"$MOBILE_CORE_ADMISSION_SIGNATURE_SCHEME","signatureVerification":"$MOBILE_CORE_ADMISSION_SIGNATURE_VERIFICATION","signerSha256":"$MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256"}"""
