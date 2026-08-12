package com.asuka109.mish.vpn

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

internal const val MOBILE_CORE_ADMISSION_SCHEMA_VERSION = 2
internal const val MOBILE_CORE_ADMISSION_MANIFEST_ASSET = "mish-mobile-core-admission.json"
internal const val MOBILE_CORE_ADMISSION_MAX_MANIFEST_BYTES = 16 * 1024
internal const val MOBILE_CORE_ADMISSION_MAX_ARTIFACT_BYTES = 128L * 1024 * 1024
internal const val MOBILE_CORE_ADMISSION_MAX_SIGNATURE_BYTES = 16 * 1024
internal const val MOBILE_CORE_ADMISSION_SIGNATURE_SCHEME = "android-package-signature-v1"
internal const val MOBILE_CORE_ADMISSION_SIGNATURE_VERIFICATION = "package-signer"
internal const val MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256 =
    "8e55b6922b8010c1ebd6c2fdce16ab1b10163f700068e67583aec20870b76934"

internal data class MobileCoreAdmissionManifest(
    val schemaVersion: Int,
    val abiVersion: Int,
    val sourceCommit: String,
    val sourceVersion: String,
    val wrapperRevision: String,
    val wrapperContractVersion: Int,
    val artifacts: List<MobileCoreAdmissionArtifact>,
    val signatureScheme: String,
    val signatureVerification: String,
    val signerSha256: String,
) {
    companion object {
        internal fun parse(encoded: String): MobileCoreAdmissionManifest? = runCatching {
            val root = JSONObject(encoded)
            requireKeys(
                root,
                setOf(
                    "abiVersion",
                    "artifacts",
                    "schemaVersion",
                    "signatureScheme",
                    "signatureVerification",
                    "signerSha256",
                    "sourceCommit",
                    "sourceVersion",
                    "wrapperContractVersion",
                    "wrapperRevision",
                ),
            )
            require(requiredInt(root, "schemaVersion") == MOBILE_CORE_ADMISSION_SCHEMA_VERSION)
            require(requiredInt(root, "abiVersion") == MobileCoreAdmissionPolicy.PINNED_ABI_VERSION)
            require(
                requiredInt(root, "wrapperContractVersion") ==
                    MobileCoreAdmissionPolicy.PINNED_WRAPPER_CONTRACT_VERSION,
            )
            val artifactsJson = root.getJSONArray("artifacts")
            require(artifactsJson.length() in 1..MobileCoreAdmissionPolicy.SUPPORTED_ABIS.size)
            val artifacts = buildList(artifactsJson.length()) {
                repeat(artifactsJson.length()) { index ->
                    val artifact = artifactsJson.getJSONObject(index)
                    requireKeys(artifact, setOf("abi", "sha256"))
                    add(
                        MobileCoreAdmissionArtifact(
                            abi = requiredString(artifact, "abi"),
                            sha256 = requiredString(artifact, "sha256"),
                        ),
                    )
                }
            }
            MobileCoreAdmissionManifest(
                schemaVersion = requiredInt(root, "schemaVersion"),
                abiVersion = requiredInt(root, "abiVersion"),
                sourceCommit = requiredString(root, "sourceCommit"),
                sourceVersion = requiredString(root, "sourceVersion"),
                wrapperRevision = requiredString(root, "wrapperRevision"),
                wrapperContractVersion = requiredInt(root, "wrapperContractVersion"),
                artifacts = artifacts,
                signatureScheme = requiredString(root, "signatureScheme"),
                signatureVerification = requiredString(root, "signatureVerification"),
                signerSha256 = requiredString(root, "signerSha256"),
            )
        }.getOrNull()

        private fun requireKeys(value: JSONObject, expected: Set<String>) {
            require(value.length() == expected.size)
            val actual = mutableSetOf<String>()
            val keys = value.keys()
            while (keys.hasNext()) actual += keys.next()
            require(actual == expected)
        }

        private fun requiredString(value: JSONObject, key: String): String {
            return value.get(key) as? String ?: error("$key must be a string")
        }

        private fun requiredInt(value: JSONObject, key: String): Int {
            val raw = value.get(key) as? Number ?: error("$key must be an integer")
            require(raw is Int || raw is Long)
            val long = raw.toLong()
            require(long in Int.MIN_VALUE..Int.MAX_VALUE)
            return long.toInt()
        }
    }
}

internal data class MobileCoreAdmissionArtifact(
    val abi: String,
    val sha256: String,
)

internal data class MobileCoreSignatureEvidence(
    val fingerprintSha256: String,
    val verified: Boolean,
)

internal enum class MobileCoreAdmissionFailure(val wireName: String) {
    MANIFEST_MISSING("manifest-missing"),
    MANIFEST_MALFORMED("manifest-malformed"),
    SOURCE_MISMATCH("source-mismatch"),
    VERSION_MISMATCH("version-mismatch"),
    WRAPPER_MISMATCH("wrapper-mismatch"),
    ABI_MISMATCH("abi-mismatch"),
    ARTIFACT_MISSING("artifact-missing"),
    ARTIFACT_DIGEST_MISMATCH("artifact-digest-mismatch"),
    SIGNATURE_MISSING("signature-missing"),
    SIGNATURE_UNVERIFIED("signature-unverified"),
    IDENTITY_MISMATCH("identity-mismatch"),
    SIGNER_FINGERPRINT_MISMATCH("signer-fingerprint-mismatch"),
}

internal data class MobileCoreAdmissionResult(
    val admitted: Boolean,
    val failure: MobileCoreAdmissionFailure? = null,
    val artifactAbi: String? = null,
    val artifactDigest: String? = null,
) {
    companion object {
        fun accepted(
            artifactAbi: String,
            artifactDigest: String,
        ): MobileCoreAdmissionResult = MobileCoreAdmissionResult(
            admitted = true,
            artifactAbi = artifactAbi,
            artifactDigest = artifactDigest,
        )

        fun rejected(failure: MobileCoreAdmissionFailure): MobileCoreAdmissionResult =
            MobileCoreAdmissionResult(admitted = false, failure = failure)
    }
}

internal enum class MobileCoreEffectOperation {
    ADMISSION,
    INSPECT,
    VALIDATE,
    LOAD,
    INSPECT_LOADED,
    START,
    STOP,
    INSPECT_RUNTIME,
}

internal data class MobileCoreAdmissionInvocation(
    val operation: MobileCoreEffectOperation,
    val result: MobileCoreAdmissionResult,
)

internal class MobileCoreAdmissionGate(
    private val admit: () -> MobileCoreAdmissionResult,
    private val observer: (MobileCoreAdmissionInvocation) -> Unit = {},
) {
    private val transcript = java.util.ArrayDeque<MobileCoreAdmissionInvocation>()

    fun <T> invoke(
        operation: MobileCoreEffectOperation,
        rejected: (MobileCoreAdmissionResult) -> T,
        effect: () -> T,
    ): T {
        val result = check(operation)
        return if (result.admitted) effect() else rejected(result)
    }

    fun check(operation: MobileCoreEffectOperation): MobileCoreAdmissionResult {
        val result = admit()
        val invocation = MobileCoreAdmissionInvocation(operation, result)
        synchronized(transcript) {
            if (transcript.size == 16) transcript.removeFirst()
            transcript.addLast(invocation)
        }
        observer(invocation)
        return result
    }

    internal fun recentInvocations(): List<MobileCoreAdmissionInvocation> =
        synchronized(transcript) { transcript.toList() }
}

internal object MobileCoreAdmissionPolicy {
    const val PINNED_SOURCE_COMMIT = "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb"
    const val PINNED_SOURCE_VERSION = "v1.19.29"
    const val PINNED_WRAPPER_REVISION = "mish-mobile-core-v1"
    const val PINNED_WRAPPER_CONTRACT_VERSION = 1
    const val PINNED_ABI_VERSION = 1

    val SUPPORTED_ABIS: Set<String> = setOf("arm64-v8a", "x86_64")

    private val COMMIT_PATTERN = Regex("^[0-9a-f]{40}$")
    private val VERSION_PATTERN = Regex("^[A-Za-z0-9._+-]{1,32}$")
    private val WRAPPER_PATTERN = Regex("^[A-Za-z0-9._-]{1,64}$")
    private val ABI_PATTERN = Regex("^[a-z0-9_-]{1,16}$")
    private val DIGEST_PATTERN = Regex("^[0-9a-f]{64}$")

    internal fun evaluate(
        manifest: MobileCoreAdmissionManifest?,
        runtimeAbi: String?,
        observedArtifactDigest: String?,
        signature: MobileCoreSignatureEvidence?,
    ): MobileCoreAdmissionResult {
        if (manifest == null) return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.MANIFEST_MALFORMED)
        if (
            manifest.schemaVersion != MOBILE_CORE_ADMISSION_SCHEMA_VERSION ||
            manifest.abiVersion != PINNED_ABI_VERSION ||
            manifest.wrapperContractVersion != PINNED_WRAPPER_CONTRACT_VERSION
        ) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.MANIFEST_MALFORMED)
        }
        if (manifest.sourceCommit != PINNED_SOURCE_COMMIT || !COMMIT_PATTERN.matches(manifest.sourceCommit)) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.SOURCE_MISMATCH)
        }
        if (manifest.sourceVersion != PINNED_SOURCE_VERSION || !VERSION_PATTERN.matches(manifest.sourceVersion)) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.VERSION_MISMATCH)
        }
        if (manifest.wrapperRevision != PINNED_WRAPPER_REVISION || !WRAPPER_PATTERN.matches(manifest.wrapperRevision)) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.WRAPPER_MISMATCH)
        }
        if (runtimeAbi == null || runtimeAbi !in SUPPORTED_ABIS) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.ABI_MISMATCH)
        }
        val artifacts = manifest.artifacts
        if (
            artifacts.map { it.abi }.toSet() != SUPPORTED_ABIS ||
            artifacts.size != artifacts.map { it.abi }.toSet().size ||
            artifacts.any { it.abi !in SUPPORTED_ABIS || !ABI_PATTERN.matches(it.abi) || !DIGEST_PATTERN.matches(it.sha256) }
        ) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.ABI_MISMATCH)
        }
        val artifact = artifacts.singleOrNull { it.abi == runtimeAbi }
            ?: return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.ARTIFACT_MISSING)
        if (observedArtifactDigest == null || observedArtifactDigest != artifact.sha256) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.ARTIFACT_DIGEST_MISMATCH)
        }
        if (manifest.signatureScheme != MOBILE_CORE_ADMISSION_SIGNATURE_SCHEME) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.IDENTITY_MISMATCH)
        }
        if (manifest.signatureVerification != MOBILE_CORE_ADMISSION_SIGNATURE_VERIFICATION) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.SIGNATURE_MISSING)
        }
        if (
            !DIGEST_PATTERN.matches(manifest.signerSha256) ||
                manifest.signerSha256 != MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256
        ) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.SIGNER_FINGERPRINT_MISMATCH)
        }
        if (signature == null) return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.SIGNATURE_MISSING)
        if (!signature.verified) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.SIGNATURE_UNVERIFIED)
        }
        if (
            !DIGEST_PATTERN.matches(signature.fingerprintSha256) ||
                signature.fingerprintSha256 != MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256
        ) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.SIGNER_FINGERPRINT_MISMATCH)
        }
        return MobileCoreAdmissionResult.accepted(
            artifactAbi = runtimeAbi,
            artifactDigest = artifact.sha256,
        )
    }

    internal fun matchesIdentity(identity: MobileCoreIdentity?): Boolean =
        identity != null &&
            identity.abiVersion == PINNED_ABI_VERSION &&
            identity.commit == PINNED_SOURCE_COMMIT &&
            identity.version == PINNED_SOURCE_VERSION &&
            identity.wrapperRevision == PINNED_WRAPPER_REVISION
}

internal fun interface MobileCoreArtifactDigestReader {
    fun read(file: File): String?
}

internal fun interface MobileCoreSignatureVerifier {
    fun verify(context: Context): MobileCoreSignatureEvidence?
}

internal class MobileCoreArtifactAdmission(
    private val context: Context,
    private val digestReader: MobileCoreArtifactDigestReader = MobileCoreArtifactDigestReader { file -> sha256(file) },
    private val signatureVerifier: MobileCoreSignatureVerifier = MobileCoreSignatureVerifier { value -> verifyPackageSignature(value) },
) {
    fun admit(): MobileCoreAdmissionResult {
        val manifestText = readManifest() ?:
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.MANIFEST_MISSING)
        val manifest = MobileCoreAdmissionManifest.parse(manifestText)
            ?: return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.MANIFEST_MALFORMED)
        val runtimeAbi = Build.SUPPORTED_ABIS.firstOrNull()
        if (runtimeAbi == null || runtimeAbi !in MobileCoreAdmissionPolicy.SUPPORTED_ABIS) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.ABI_MISMATCH)
        }
        val artifact = runtimeAbi.let {
            context.applicationInfo.nativeLibraryDir?.let { directory ->
                File(directory, "libmish_mobile_core.so")
            }
        }
        if (artifact == null || !artifact.isFile) {
            return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.ARTIFACT_MISSING)
        }
        val digest = runCatching { digestReader.read(artifact) }.getOrNull()
        val signature = runCatching { signatureVerifier.verify(context) }.getOrNull()
        return MobileCoreAdmissionPolicy.evaluate(manifest, runtimeAbi, digest, signature)
    }

    private fun readManifest(): String? = runCatching {
        context.assets.open(MOBILE_CORE_ADMISSION_MANIFEST_ASSET).use { input ->
            readBoundedUtf8(input, MOBILE_CORE_ADMISSION_MAX_MANIFEST_BYTES)
        }
    }.getOrNull()

    companion object {
        private fun readBoundedUtf8(input: InputStream, maximumBytes: Int): String {
            val bytes = input.readBytesBounded(maximumBytes)
            return bytes.toString(Charsets.UTF_8).also {
                require(it.toByteArray(Charsets.UTF_8).contentEquals(bytes))
            }
        }

        private fun InputStream.readBytesBounded(maximumBytes: Int): ByteArray {
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            var total = 0
            while (true) {
                val count = read(buffer)
                if (count < 0) break
                total += count
                require(total <= maximumBytes)
                output.write(buffer, 0, count)
            }
            return output.toByteArray()
        }

        private fun sha256(file: File): String? {
            if (!file.isFile || file.length() <= 0L || file.length() > MOBILE_CORE_ADMISSION_MAX_ARTIFACT_BYTES) {
                return null
            }
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    if (total > MOBILE_CORE_ADMISSION_MAX_ARTIFACT_BYTES) return null
                    digest.update(buffer, 0, count)
                }
            }
            return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
        }

        private fun verifyPackageSignature(context: Context): MobileCoreSignatureEvidence? {
            val packageManager = context.packageManager
            val packageInfo = packageManager.getPackageInfo(
                context.packageName,
                PackageManager.GET_SIGNING_CERTIFICATES,
            )
            val signingInfo = packageInfo.signingInfo ?: return null
            val signers = signingInfo.apkContentsSigners
            if (signers.size != 1) return null
            return observePackageSigners(signers.map { it.toByteArray() })
        }
    }
}

/**
 * Converts the one signer returned by PackageManager into a bounded digest-only
 * observation. Certificate bytes never enter admission facts, transcripts, or
 * diagnostics.
 */
internal fun observePackageSigners(signers: List<ByteArray>): MobileCoreSignatureEvidence? {
    if (signers.size != 1) return null
    val certificateBytes = signers.single()
    if (certificateBytes.isEmpty() || certificateBytes.size > MOBILE_CORE_ADMISSION_MAX_SIGNATURE_BYTES) {
        return null
    }
    val fingerprint = MessageDigest.getInstance("SHA-256")
        .digest(certificateBytes)
        .joinToString("") { byte -> "%02x".format(byte) }
    return MobileCoreSignatureEvidence(fingerprintSha256 = fingerprint, verified = true)
}
