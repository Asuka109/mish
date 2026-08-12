package com.asuka109.mish.vpn

import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal const val MOBILE_CORE_PROVENANCE_SCHEMA_VERSION = 1

internal enum class MobileCoreProvenanceState(val wireName: String) {
    NOT_EVALUATED("not-evaluated"),
    ADMITTED("admitted"),
    REJECTED("rejected"),
}

internal enum class MobileCoreProvenanceClassification(val wireName: String) {
    NOT_EVALUATED("not-evaluated"),
    AVAILABLE("available"),
    MANIFEST("manifest"),
    SOURCE("source"),
    WRAPPER("wrapper"),
    ABI("abi"),
    ARTIFACT("artifact"),
    SIGNER("signer"),
    NATIVE_IDENTITY("native-identity"),
}

internal data class MobileCoreProvenanceEvidence(
    val manifestSchemaVersion: Int? = null,
    val sourceCommit: String? = null,
    val sourceVersion: String? = null,
    val wrapperRevision: String? = null,
    val wrapperContractVersion: Int? = null,
    val abiVersion: Int? = null,
    val selectedAbi: String? = null,
    val artifactDigest: String? = null,
    val signerFingerprint: String? = null,
    val signatureVerification: String? = null,
) {
    init {
        require(manifestSchemaVersion == null || manifestSchemaVersion == 2)
        require(sourceCommit == null || sourceCommit.matches(Regex("^[0-9a-f]{40}$")))
        require(sourceVersion == null || sourceVersion.matches(Regex("^[A-Za-z0-9._+-]{1,32}$")))
        require(wrapperRevision == null || wrapperRevision.matches(Regex("^[A-Za-z0-9._-]{1,64}$")))
        require(wrapperContractVersion == null || wrapperContractVersion == 1)
        require(abiVersion == null || abiVersion == 1)
        require(selectedAbi == null || selectedAbi in MobileCoreAdmissionPolicy.SUPPORTED_ABIS)
        require(artifactDigest == null || artifactDigest.matches(DIGEST_PATTERN))
        require(signerFingerprint == null || signerFingerprint.matches(DIGEST_PATTERN))
        require(signatureVerification == null || signatureVerification in SIGNATURE_RESULTS)
        require(signatureVerification == "verified" || signerFingerprint == null)
    }

    private companion object {
        val DIGEST_PATTERN = Regex("^[0-9a-f]{64}$")
        val SIGNATURE_RESULTS = setOf("missing", "mismatch", "unverified", "verified")
    }
}

internal data class MobileCoreProvenanceSnapshot(
    val authorityId: String,
    val generation: Long,
    val state: MobileCoreProvenanceState,
    val classification: MobileCoreProvenanceClassification,
    val evidence: MobileCoreProvenanceEvidence? = null,
) {
    init {
        require(authorityId.matches(Regex("^[A-Za-z0-9._-]{1,128}$")))
        require(generation in 0..ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX)
        require(state != MobileCoreProvenanceState.NOT_EVALUATED || evidence == null)
        require((state == MobileCoreProvenanceState.ADMITTED) == (classification == MobileCoreProvenanceClassification.AVAILABLE))
        require(state != MobileCoreProvenanceState.ADMITTED || evidence?.artifactDigest != null)
    }

    fun toJson(): JSONObject = JSONObject()
        .put("authorityId", authorityId)
        .put("classification", classification.wireName)
        .put("evidence", evidence?.toJson() ?: JSONObject.NULL)
        .put("generation", generation)
        .put("schemaVersion", MOBILE_CORE_PROVENANCE_SCHEMA_VERSION)
        .put("state", state.wireName)
}

private fun MobileCoreProvenanceEvidence.toJson(): JSONObject = JSONObject()
    .put("abiVersion", abiVersion ?: JSONObject.NULL)
    .put("artifactDigest", artifactDigest ?: JSONObject.NULL)
    .put("manifestSchemaVersion", manifestSchemaVersion ?: JSONObject.NULL)
    .put("selectedAbi", selectedAbi ?: JSONObject.NULL)
    .put("signatureVerification", signatureVerification ?: JSONObject.NULL)
    .put("signerFingerprint", signerFingerprint ?: JSONObject.NULL)
    .put("sourceCommit", sourceCommit ?: JSONObject.NULL)
    .put("sourceVersion", sourceVersion ?: JSONObject.NULL)
    .put("wrapperContractVersion", wrapperContractVersion ?: JSONObject.NULL)
    .put("wrapperRevision", wrapperRevision ?: JSONObject.NULL)

internal class MobileCoreProvenanceProjection(
    private val authorityId: String = "mobile-core-provenance-${UUID.randomUUID()}",
) {
    private val generation = AtomicLong(0)
    private val snapshot = AtomicReference(
        MobileCoreProvenanceSnapshot(
            authorityId = authorityId,
            generation = 0,
            state = MobileCoreProvenanceState.NOT_EVALUATED,
            classification = MobileCoreProvenanceClassification.NOT_EVALUATED,
        ),
    )

    fun publish(result: MobileCoreAdmissionResult): MobileCoreProvenanceSnapshot {
        val next = MobileCoreProvenanceSnapshot(
            authorityId = authorityId,
            generation = generation.incrementAndGet(),
            state = if (result.admitted) MobileCoreProvenanceState.ADMITTED else MobileCoreProvenanceState.REJECTED,
            classification = result.classification(),
            evidence = result.provenance,
        )
        snapshot.set(next)
        return next
    }

    fun current(): MobileCoreProvenanceSnapshot = snapshot.get()
}

private fun MobileCoreAdmissionResult.classification(): MobileCoreProvenanceClassification =
    when (failure) {
        null -> MobileCoreProvenanceClassification.AVAILABLE
        MobileCoreAdmissionFailure.MANIFEST_MISSING,
        MobileCoreAdmissionFailure.MANIFEST_MALFORMED,
        -> MobileCoreProvenanceClassification.MANIFEST
        MobileCoreAdmissionFailure.SOURCE_MISMATCH,
        MobileCoreAdmissionFailure.VERSION_MISMATCH,
        -> MobileCoreProvenanceClassification.SOURCE
        MobileCoreAdmissionFailure.WRAPPER_MISMATCH -> MobileCoreProvenanceClassification.WRAPPER
        MobileCoreAdmissionFailure.ABI_MISMATCH -> MobileCoreProvenanceClassification.ABI
        MobileCoreAdmissionFailure.ARTIFACT_MISSING,
        MobileCoreAdmissionFailure.ARTIFACT_TRUNCATED,
        MobileCoreAdmissionFailure.ARTIFACT_OVERSIZED,
        MobileCoreAdmissionFailure.ARTIFACT_REPLACED,
        MobileCoreAdmissionFailure.ARTIFACT_DIGEST_MISMATCH,
        -> MobileCoreProvenanceClassification.ARTIFACT
        MobileCoreAdmissionFailure.SIGNATURE_MISSING,
        MobileCoreAdmissionFailure.SIGNATURE_UNVERIFIED,
        MobileCoreAdmissionFailure.SIGNER_FINGERPRINT_MISMATCH,
        -> MobileCoreProvenanceClassification.SIGNER
        MobileCoreAdmissionFailure.IDENTITY_MISMATCH -> MobileCoreProvenanceClassification.NATIVE_IDENTITY
    }
