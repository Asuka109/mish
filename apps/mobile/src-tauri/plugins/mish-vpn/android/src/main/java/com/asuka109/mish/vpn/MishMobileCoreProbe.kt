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

internal enum class NativeRuntimeCode(val nativeCode: Int) {
    RUNNING(0),
    INACTIVE(1),
    CONFLICT(2),
    NOT_LOADED(3),
    CORE_UNAVAILABLE(4),
    PROTECTION_FAILED(5),
    MALFORMED_RESPONSE(6),
    NATIVE_FAILED(7),
    JNI_EXCEPTION(8),
}

internal data class NativeRuntimeResult(
    val code: NativeRuntimeCode,
    val abiStatus: Int = -1,
)

internal interface MobileCoreRuntime {
    fun start(
        productSessionId: String,
        tunFileDescriptor: Int,
        vpnService: MishVpnService,
    ): NativeRuntimeResult

    fun stop(productSessionId: String?): NativeRuntimeResult

    fun inspectRuntime(productSessionId: String?): NativeRuntimeResult
}

internal class MishMobileCoreProbe :
    MobileCoreProbe,
    MobileCoreConfigValidator,
    MobileCoreConfigLoader,
    MobileCoreConfigInspector,
    MobileCoreRuntime {
    override fun inspect(): MobileCoreIdentity? {
        if (!shimLoaded) return null
        val abiVersion = runCatching { nativeAbiVersion() }.getOrDefault(0)
        if (abiVersion != CONTRACT_VERSION) return null
        val encoded = runCatching { nativeVersionEnvelope() }.getOrNull() ?: return null
        return parseIdentity(encoded, abiVersion)
    }

    private external fun nativeAbiVersion(): Int

    private external fun nativeVersionEnvelope(): String?

    override fun validate(
        configBytes: ByteArray,
        expectedDigest: String,
    ): NativeConfigValidationResult {
        if (!shimLoaded) return NativeConfigValidationResult(NativeValidationCode.CORE_UNAVAILABLE)
        val encoded = try {
            nativeValidateConfig(configBytes, expectedDigest)
        } catch (_: Throwable) {
            return NativeConfigValidationResult(NativeValidationCode.JNI_EXCEPTION)
        } ?: return NativeConfigValidationResult(NativeValidationCode.NATIVE_FAILED)
        return parseValidation(encoded)
    }

    override fun load(
        configBytes: ByteArray,
        expectedDigest: String,
        injectFailure: Boolean,
    ): NativeConfigLoadResult {
        if (!shimLoaded) return NativeConfigLoadResult(NativeLoadCode.CORE_UNAVAILABLE)
        if (injectFailure) {
            return NativeConfigLoadResult(
                code = NativeLoadCode.NATIVE_FAILED,
                abiStatus = 8,
                rollbackGuaranteed = true,
            )
        }
        val encoded = try {
            nativeLoadConfig(configBytes, expectedDigest)
        } catch (_: Throwable) {
            return NativeConfigLoadResult(NativeLoadCode.JNI_EXCEPTION)
        } ?: return NativeConfigLoadResult(NativeLoadCode.NATIVE_FAILED)
        return parseLoad(encoded)
    }

    override fun inspectLoaded(expectedDigest: String?): NativeConfigInspectionResult {
        if (!shimLoaded) return NativeConfigInspectionResult(NativeInspectionCode.NATIVE_FAILED)
        val encoded = try {
            nativeInspectLoadedConfig(expectedDigest)
        } catch (_: Throwable) {
            return NativeConfigInspectionResult(NativeInspectionCode.NATIVE_FAILED)
        } ?: return NativeConfigInspectionResult(NativeInspectionCode.MALFORMED_RESPONSE)
        return parseInspection(encoded)
    }

    private external fun nativeValidateConfig(
        configBytes: ByteArray,
        expectedDigest: String,
    ): IntArray?

    private external fun nativeLoadConfig(
        configBytes: ByteArray,
        expectedDigest: String,
    ): IntArray?

    private external fun nativeInspectLoadedConfig(expectedDigest: String?): IntArray?

    override fun start(
        productSessionId: String,
        tunFileDescriptor: Int,
        vpnService: MishVpnService,
    ): NativeRuntimeResult = runtimeCall {
        nativeStartCore(productSessionId, tunFileDescriptor, vpnService)
    }

    override fun stop(productSessionId: String?): NativeRuntimeResult = runtimeCall {
        nativeStopCore(productSessionId)
    }

    override fun inspectRuntime(productSessionId: String?): NativeRuntimeResult = runtimeCall {
        nativeInspectRuntime(productSessionId)
    }

    private fun runtimeCall(call: () -> IntArray?): NativeRuntimeResult {
        if (!shimLoaded) return NativeRuntimeResult(NativeRuntimeCode.CORE_UNAVAILABLE)
        val encoded = try {
            call()
        } catch (_: Throwable) {
            return NativeRuntimeResult(NativeRuntimeCode.JNI_EXCEPTION)
        } ?: return NativeRuntimeResult(NativeRuntimeCode.MALFORMED_RESPONSE)
        return parseRuntime(encoded)
    }

    private external fun nativeStartCore(
        productSessionId: String,
        tunFileDescriptor: Int,
        vpnService: MishVpnService,
    ): IntArray?

    private external fun nativeStopCore(productSessionId: String?): IntArray?

    private external fun nativeInspectRuntime(productSessionId: String?): IntArray?

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

        internal fun parseLoad(encoded: IntArray): NativeConfigLoadResult {
            if (encoded.size != 3) {
                return NativeConfigLoadResult(NativeLoadCode.MALFORMED_RESPONSE)
            }
            val code = NativeLoadCode.entries.firstOrNull { it.nativeCode == encoded[0] }
                ?: NativeLoadCode.NATIVE_FAILED
            return NativeConfigLoadResult(code, encoded[1], encoded[2] == 1)
        }

        internal fun parseInspection(encoded: IntArray): NativeConfigInspectionResult {
            if (encoded.size != 2) {
                return NativeConfigInspectionResult(NativeInspectionCode.MALFORMED_RESPONSE)
            }
            val code = NativeInspectionCode.entries.firstOrNull { it.nativeCode == encoded[0] }
                ?: NativeInspectionCode.NATIVE_FAILED
            return NativeConfigInspectionResult(code, encoded[1])
        }

        internal fun parseRuntime(encoded: IntArray): NativeRuntimeResult {
            if (encoded.size != 2) {
                return NativeRuntimeResult(NativeRuntimeCode.MALFORMED_RESPONSE)
            }
            val code = NativeRuntimeCode.entries.firstOrNull { it.nativeCode == encoded[0] }
                ?: NativeRuntimeCode.NATIVE_FAILED
            return NativeRuntimeResult(code, encoded[1])
        }
    }
}
