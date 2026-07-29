package com.asuka109.mish.vpn

import app.tauri.annotation.InvokeArg
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

internal const val MOBILE_CORE_MAX_CONFIG_BYTES_V1 = 1_048_576

@InvokeArg
internal class ValidateConfigArgs {
    lateinit var configBytes: IntArray
    var sequence: Long = -1
    var sessionId: String = ""
}

internal enum class NativeValidationCode(val nativeCode: Int) {
    VALID(0),
    CONFIG_REJECTED(1),
    CONFIG_TOO_LARGE(2),
    CORE_UNAVAILABLE(3),
    INITIALIZATION_FAILED(4),
    MALFORMED_RESPONSE(5),
    RESPONSE_TOO_LARGE(6),
    NATIVE_FAILED(7),
    JNI_EXCEPTION(8),
}

internal data class NativeConfigValidationResult(
    val code: NativeValidationCode,
    val abiStatus: Int = -1,
)

internal interface MobileCoreConfigValidator {
    fun validate(
        configBytes: ByteArray,
        expectedDigest: String,
    ): NativeConfigValidationResult
}

internal data class MobileConfigValidationResult(
    val contractVersion: Int = CONTRACT_VERSION,
    val failure: String?,
    val message: String,
    val outcome: String,
    val sequence: Long,
    val sessionId: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("contractVersion", contractVersion)
        .put("failure", failure)
        .put("message", message)
        .put("outcome", outcome)
        .put("sequence", sequence)
        .put("sessionId", sessionId)

    companion object {
        fun valid(snapshot: MobileVpnSnapshot): MobileConfigValidationResult =
            MobileConfigValidationResult(
                contractVersion = CONTRACT_VERSION,
                failure = null,
                message = "Configuration is valid.",
                outcome = "valid",
                sequence = snapshot.sequence,
                sessionId = snapshot.sessionId,
            )

        fun invalid(snapshot: MobileVpnSnapshot): MobileConfigValidationResult =
            failure(
                snapshot,
                "configuration-rejected",
                "Configuration was rejected by Mobile Core.",
                "invalid",
            )

        fun failure(
            snapshot: MobileVpnSnapshot,
            failure: String,
            message: String,
            outcome: String = "failed",
        ): MobileConfigValidationResult {
            check(message.length <= 256)
            return MobileConfigValidationResult(
                contractVersion = CONTRACT_VERSION,
                failure = failure,
                message = message,
                outcome = outcome,
                sequence = snapshot.sequence,
                sessionId = snapshot.sessionId,
            )
        }
    }
}

internal class MobileConfigValidationCoordinator(
    private val repository: SnapshotRepository,
    private val validator: MobileCoreConfigValidator,
) {
    private val validationActive = AtomicBoolean(false)

    fun validate(args: ValidateConfigArgs): MobileConfigValidationResult {
        val initial = repository.current()
        if (!validationActive.compareAndSet(false, true)) {
            return MobileConfigValidationResult.failure(
                initial,
                "duplicate-command",
                "Another configuration validation is already pending.",
            )
        }

        try {
            if (args.sequence != initial.sequence || args.sessionId != initial.sessionId) {
                return staleAuthority(initial)
            }
            if (args.configBytes.size > MOBILE_CORE_MAX_CONFIG_BYTES_V1) {
                return MobileConfigValidationResult.failure(
                    initial,
                    "configuration-too-large",
                    "Configuration exceeds the Mobile Core v1 size limit.",
                )
            }
            if (args.configBytes.any { it !in 0..255 }) {
                return MobileConfigValidationResult.failure(
                    initial,
                    "plugin-failure",
                    "The Android validation plugin rejected malformed byte input.",
                )
            }

            val bytes = ByteArray(args.configBytes.size) { args.configBytes[it].toByte() }
            val nativeResult = try {
                validator.validate(bytes, sha256Hex(bytes))
            } finally {
                bytes.fill(0)
            }
            val current = repository.current()
            if (
                current.sequence != initial.sequence ||
                current.sessionId != initial.sessionId
            ) {
                return staleAuthority(current)
            }
            return mapNativeResult(current, nativeResult)
        } finally {
            validationActive.set(false)
        }
    }

    private fun mapNativeResult(
        snapshot: MobileVpnSnapshot,
        nativeResult: NativeConfigValidationResult,
    ): MobileConfigValidationResult = when (nativeResult.code) {
        NativeValidationCode.VALID -> MobileConfigValidationResult.valid(snapshot)
        NativeValidationCode.CONFIG_REJECTED -> MobileConfigValidationResult.invalid(snapshot)
        NativeValidationCode.CONFIG_TOO_LARGE -> MobileConfigValidationResult.failure(
            snapshot,
            "configuration-too-large",
            "Configuration exceeds the Mobile Core v1 size limit.",
        )
        NativeValidationCode.CORE_UNAVAILABLE -> MobileConfigValidationResult.failure(
            snapshot,
            "core-unavailable",
            "The packaged Mobile Core is unavailable.",
        )
        NativeValidationCode.INITIALIZATION_FAILED -> MobileConfigValidationResult.failure(
            snapshot,
            "core-initialization-failed",
            "Mobile Core initialization failed safely.",
        )
        NativeValidationCode.MALFORMED_RESPONSE -> MobileConfigValidationResult.failure(
            snapshot,
            "malformed-native-response",
            "Mobile Core returned a malformed validation envelope.",
        )
        NativeValidationCode.RESPONSE_TOO_LARGE -> MobileConfigValidationResult.failure(
            snapshot,
            "native-response-too-large",
            "Mobile Core returned an oversized validation envelope.",
        )
        NativeValidationCode.NATIVE_FAILED -> MobileConfigValidationResult.failure(
            snapshot,
            "native-validation-failed",
            "Mobile Core validation failed safely.",
        )
        NativeValidationCode.JNI_EXCEPTION -> MobileConfigValidationResult.failure(
            snapshot,
            "native-validation-failed",
            "The Mobile Core JNI validation boundary failed safely.",
        )
    }

    private fun staleAuthority(snapshot: MobileVpnSnapshot): MobileConfigValidationResult =
        MobileConfigValidationResult.failure(
            snapshot,
            "stale-authority",
            "The mobile runtime authority is stale.",
        )
}

internal fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

internal fun validateConfigSafely(
    coordinator: MobileConfigValidationCoordinator,
    args: ValidateConfigArgs,
    currentSnapshot: () -> MobileVpnSnapshot,
): MobileConfigValidationResult =
    runCatching { coordinator.validate(args) }
        .getOrElse {
            MobileConfigValidationResult.failure(
                currentSnapshot(),
                "plugin-failure",
                "The Android validation plugin rejected malformed command input.",
            )
        }
