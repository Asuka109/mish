package com.asuka109.mish.vpn

import org.json.JSONObject

internal data class MobileCoreIdentity(
    val abiVersion: Int,
    val commit: String,
    val version: String,
    val wrapperRevision: String,
)

internal interface MobileCoreProbe {
    fun inspect(): MobileCoreIdentity?
}

internal class MishMobileCoreProbe : MobileCoreProbe, MobileCoreConfigValidator {
    override fun inspect(): MobileCoreIdentity? {
        if (!shimLoaded) return null
        val abiVersion = runCatching { nativeAbiVersion() }.getOrDefault(0)
        if (abiVersion != CONTRACT_VERSION) return null
        val encoded = runCatching { nativeVersionEnvelope() }.getOrNull() ?: return null
        return parseIdentity(encoded, abiVersion)
    }

    private external fun nativeAbiVersion(): Int

    private external fun nativeVersionEnvelope(): String?

    override fun validate(configBytes: ByteArray): NativeConfigValidationResult {
        if (!shimLoaded) return NativeConfigValidationResult(NativeValidationCode.CORE_UNAVAILABLE)
        val encoded = runCatching { nativeValidateConfig(configBytes) }.getOrNull()
            ?: return NativeConfigValidationResult(NativeValidationCode.NATIVE_FAILED)
        return parseValidation(encoded)
    }

    private external fun nativeValidateConfig(configBytes: ByteArray): IntArray?

    companion object {
        private val shimLoaded = runCatching { System.loadLibrary("mish_vpn_jni") }.isSuccess

        internal fun parseIdentity(encoded: String, abiVersion: Int): MobileCoreIdentity? =
            runCatching {
                val root = JSONObject(encoded)
                if (root.optInt("abiVersion") != CONTRACT_VERSION || root.has("error")) return null
                val data = root.getJSONObject("data")
                val identity = MobileCoreIdentity(
                    abiVersion = data.getInt("abiVersion"),
                    commit = data.getString("mihomoCommit"),
                    version = data.getString("mihomoVersion"),
                    wrapperRevision = data.getString("wrapperRevision"),
                )
                if (
                    identity.abiVersion != abiVersion ||
                    identity.commit.length !in 7..64 ||
                    identity.version.length !in 1..32 ||
                    identity.wrapperRevision.length !in 1..64
                ) {
                    return null
                }
                identity
            }.getOrNull()

        internal fun parseValidation(encoded: IntArray): NativeConfigValidationResult {
            if (encoded.size != 2) {
                return NativeConfigValidationResult(NativeValidationCode.MALFORMED_RESPONSE)
            }
            val code = NativeValidationCode.entries.firstOrNull { it.nativeCode == encoded[0] }
                ?: NativeValidationCode.NATIVE_FAILED
            return NativeConfigValidationResult(code, encoded[1])
        }
    }
}
