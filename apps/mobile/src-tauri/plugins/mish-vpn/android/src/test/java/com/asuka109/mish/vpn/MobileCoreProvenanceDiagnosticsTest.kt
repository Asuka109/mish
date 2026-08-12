package com.asuka109.mish.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileCoreProvenanceDiagnosticsTest {
    @Test
    fun `admitted decision publishes the exact bounded verified provenance`() {
        val projection = MobileCoreProvenanceProjection("provenance-authority")
        val snapshot = projection.publish(admittedResult())

        assertEquals(MobileCoreProvenanceState.ADMITTED, snapshot.state)
        assertEquals(MobileCoreProvenanceClassification.AVAILABLE, snapshot.classification)
        assertEquals(1, snapshot.generation)
        assertEquals("arm64-v8a", snapshot.evidence?.selectedAbi)
        assertEquals("a".repeat(64), snapshot.evidence?.artifactDigest)
        assertEquals(MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256, snapshot.evidence?.signerFingerprint)
        assertEquals("verified", snapshot.evidence?.signatureVerification)
    }

    @Test
    fun `unavailable and every closed rejection class remain bounded`() {
        val projection = MobileCoreProvenanceProjection("provenance-authority")
        assertEquals(MobileCoreProvenanceState.NOT_EVALUATED, projection.current().state)
        assertNull(projection.current().evidence)

        val classes = MobileCoreAdmissionFailure.entries.associateWith { failure ->
            projection.publish(
                MobileCoreAdmissionResult.rejected(failure).withProvenance(baseEvidence()),
            ).classification
        }
        assertEquals(MobileCoreProvenanceClassification.MANIFEST, classes[MobileCoreAdmissionFailure.MANIFEST_MISSING])
        assertEquals(MobileCoreProvenanceClassification.SOURCE, classes[MobileCoreAdmissionFailure.SOURCE_MISMATCH])
        assertEquals(MobileCoreProvenanceClassification.WRAPPER, classes[MobileCoreAdmissionFailure.WRAPPER_MISMATCH])
        assertEquals(MobileCoreProvenanceClassification.ABI, classes[MobileCoreAdmissionFailure.ABI_MISMATCH])
        assertEquals(MobileCoreProvenanceClassification.ARTIFACT, classes[MobileCoreAdmissionFailure.ARTIFACT_REPLACED])
        assertEquals(MobileCoreProvenanceClassification.SIGNER, classes[MobileCoreAdmissionFailure.SIGNATURE_UNVERIFIED])
        assertEquals(MobileCoreProvenanceClassification.NATIVE_IDENTITY, classes[MobileCoreAdmissionFailure.IDENTITY_MISMATCH])
    }

    @Test
    fun `authority replacement starts a new bounded generation without history`() {
        val first = MobileCoreProvenanceProjection("authority-a")
        first.publish(admittedResult())
        first.publish(MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.ARTIFACT_REPLACED).withProvenance(baseEvidence()))

        val replacement = MobileCoreProvenanceProjection("authority-b")
        assertEquals("authority-b", replacement.current().authorityId)
        assertEquals(0, replacement.current().generation)
        assertEquals(MobileCoreProvenanceState.NOT_EVALUATED, replacement.current().state)
        assertEquals(2, first.current().generation)
    }

    @Test
    fun `diagnostic JSON contains exact keys and no private payload shapes`() {
        val encoded = MobileCoreProvenanceProjection("provenance-authority")
            .publish(admittedResult())
            .toJson()
        assertEquals(
            setOf("authorityId", "classification", "evidence", "generation", "schemaVersion", "state"),
            encoded.keySet(),
        )
        val evidence = encoded.getJSONObject("evidence")
        assertEquals(
            setOf(
                "abiVersion", "artifactDigest", "manifestSchemaVersion", "selectedAbi",
                "signatureVerification", "signerFingerprint", "sourceCommit", "sourceVersion",
                "wrapperContractVersion", "wrapperRevision",
            ),
            evidence.keySet(),
        )
        val text = encoded.toString().lowercase()
        for (forbidden in listOf("/users/", "/private/", "certificate", "subject", "token", "credential", "private-key", "config", "subscription", "node", "process", "network")) {
            assertFalse(text.contains(forbidden))
        }
        assertTrue(text.length < 1024)
        assertThrows(IllegalArgumentException::class.java) {
            baseEvidence().copy(sourceVersion = "/Users/private/core")
        }
        assertThrows(IllegalArgumentException::class.java) {
            baseEvidence().copy(artifactDigest = "a".repeat(65))
        }
        assertThrows(IllegalArgumentException::class.java) {
            baseEvidence().copy(signatureVerification = "verified", signerFingerprint = "certificate-subject")
        }
    }

    @Test
    fun `diagnostic rendering does not reobserve admission inputs`() {
        var admissions = 0
        val probe = MishMobileCoreProbe(
            admissionReader = { admissions += 1; admittedResult() },
            shimLoader = { false },
        )

        probe.admission()
        val first = probe.provenanceSnapshot().toJson().toString()
        val second = probe.provenanceSnapshot().toJson().toString()

        assertEquals(1, admissions)
        assertEquals(first, second)
    }
}

private fun admittedResult() = MobileCoreAdmissionResult.accepted("arm64-v8a", "a".repeat(64))
    .withProvenance(baseEvidence())

private fun baseEvidence() = MobileCoreProvenanceEvidence(
    manifestSchemaVersion = 2,
    sourceCommit = MobileCoreAdmissionPolicy.PINNED_SOURCE_COMMIT,
    sourceVersion = MobileCoreAdmissionPolicy.PINNED_SOURCE_VERSION,
    wrapperRevision = MobileCoreAdmissionPolicy.PINNED_WRAPPER_REVISION,
    wrapperContractVersion = 1,
    abiVersion = 1,
    selectedAbi = "arm64-v8a",
    artifactDigest = "a".repeat(64),
    signerFingerprint = MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256,
    signatureVerification = "verified",
)
