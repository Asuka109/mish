package com.asuka109.mish.vpn

import android.content.Context
import app.tauri.annotation.InvokeArg
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal const val MOBILE_CORE_MAX_LOAD_TIMEOUT_MILLIS = 30_000L

internal data class MobileCoreProcessRuntime(
    val configExecutor: ExecutorService,
    val coreProbe: MishMobileCoreProbe,
    val loadCoordinator: MobileConfigLoadCoordinator,
    val platformExecutor: ExecutorService,
    val store: MishVpnPlatformStore,
    val validationCoordinator: MobileConfigValidationCoordinator,
)

internal object MobileCoreProcessRuntimeRegistry {
    @Volatile
    private var runtime: MobileCoreProcessRuntime? = null

    fun acquire(
        context: Context,
        allowFailureInjection: Boolean,
    ): MobileCoreProcessRuntime =
        runtime ?: synchronized(this) {
            runtime ?: create(context, allowFailureInjection).also { runtime = it }
        }

    private fun create(
        context: Context,
        allowFailureInjection: Boolean,
    ): MobileCoreProcessRuntime {
        val coreProbe = MishMobileCoreProbe(context.applicationContext)
        val store = MishVpnPlatformStore(context.applicationContext)
        return MobileCoreProcessRuntime(
            configExecutor = Executors.newSingleThreadExecutor { runnable ->
                Thread(runnable, "mish-config-core").apply { isDaemon = true }
            },
            coreProbe = coreProbe,
            loadCoordinator = MobileConfigLoadCoordinator(
                repository = store,
                validator = coreProbe,
                loader = coreProbe,
                allowFailureInjection = allowFailureInjection,
            ),
            platformExecutor = Executors.newSingleThreadExecutor { runnable ->
                Thread(runnable, "mish-vpn-platform-await").apply { isDaemon = true }
            },
            store = store,
            validationCoordinator = MobileConfigValidationCoordinator(store, coreProbe),
        )
    }
}

@InvokeArg
internal class LoadConfigArgs {
    lateinit var configBytes: IntArray
    lateinit var digest: String
    var injectFailure: Boolean = false
    lateinit var operationId: String
    lateinit var revision: String
    var sequence: Long = -1
    var sessionId: String = ""
    var timeoutMillis: Long = 0
}

@InvokeArg
internal class CancelConfigLoadArgs {
    var operationId: String = ""
}

internal enum class NativeLoadCode(val nativeCode: Int) {
    LOADED(0),
    CONFIG_REJECTED(1),
    CONFLICT(2),
    CORE_UNAVAILABLE(3),
    NOT_INITIALIZED(4),
    MALFORMED_RESPONSE(5),
    RESPONSE_TOO_LARGE(6),
    NATIVE_FAILED(7),
    JNI_EXCEPTION(8),
}

internal data class NativeConfigLoadResult(
    val code: NativeLoadCode,
    val abiStatus: Int = -1,
    val rollbackGuaranteed: Boolean = false,
)

internal interface MobileCoreConfigLoader {
    fun load(
        configBytes: ByteArray,
        expectedDigest: String,
        injectFailure: Boolean,
    ): NativeConfigLoadResult
}

internal enum class NativeInspectionCode(val nativeCode: Int) {
    UNLOADED(0),
    LOADED_EXPECTED(1),
    LOADED_OTHER(2),
    MALFORMED_RESPONSE(3),
    RESPONSE_TOO_LARGE(4),
    NATIVE_FAILED(5),
}

internal data class NativeConfigInspectionResult(
    val code: NativeInspectionCode,
    val abiStatus: Int = -1,
)

internal interface MobileCoreConfigInspector {
    fun inspectLoaded(expectedDigest: String?): NativeConfigInspectionResult
}

internal data class MobileConfigCancelResult(
    val accepted: Boolean,
    val contractVersion: Int = CONTRACT_VERSION,
    val operationId: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("accepted", accepted)
        .put("contractVersion", contractVersion)
        .put("operationId", operationId)
}

internal data class MobileConfigLoadResult(
    val cancellation: String,
    val contractVersion: Int = CONTRACT_VERSION,
    val digest: String,
    val failure: String?,
    val message: String,
    val operationId: String,
    val outcome: String,
    val revision: String,
    val rollback: String,
    val facts: MobilePlatformFacts,
    val timing: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("cancellation", cancellation)
        .put("contractVersion", contractVersion)
        .put("digest", digest)
        .put("failure", failure)
        .put("message", message)
        .put("operationId", operationId)
        .put("outcome", outcome)
        .put("revision", revision)
        .put("rollback", rollback)
        .put("facts", facts.toJson())
        .put("timing", timing)
}

private data class ActiveConfigLoad(
    val cancelled: AtomicBoolean = AtomicBoolean(false),
    val operationId: String,
)

internal class MobileConfigLoadCoordinator(
    private val repository: PlatformFactRepository,
    private val validator: MobileCoreConfigValidator,
    private val loader: MobileCoreConfigLoader,
    private val allowFailureInjection: Boolean = false,
    private val clockMillis: () -> Long = System::currentTimeMillis,
) {
    private val active = AtomicReference<ActiveConfigLoad?>()
    private val cancellationTombstones = LinkedHashSet<String>()

    fun cancel(operationId: String): MobileConfigCancelResult {
        if (operationId.isBlank() || operationId.length > 128) {
            return MobileConfigCancelResult(false, operationId = operationId.take(128))
        }
        val current = active.get()
        if (current?.operationId == operationId) {
            current.cancelled.set(true)
        } else {
            synchronized(cancellationTombstones) {
                cancellationTombstones += operationId
                while (cancellationTombstones.size > 32) {
                    cancellationTombstones.remove(cancellationTombstones.first())
                }
            }
        }
        return MobileConfigCancelResult(true, operationId = operationId)
    }

    fun load(args: LoadConfigArgs): MobileConfigLoadResult {
        val initial = repository.current()
        val operation = ActiveConfigLoad(operationId = args.operationIdOrEmpty())
        if (!active.compareAndSet(null, operation)) {
            return failure(
                args,
                initial,
                "duplicate-command",
                "Another configuration load is already pending.",
            )
        }

        var bytes: ByteArray? = null
        try {
            consumeCancellation(args.operationIdOrEmpty(), operation)
            preflightFailure(args, initial)?.let { return it }
            bytes = ByteArray(args.configBytes.size) { args.configBytes[it].toByte() }
            if (sha256Hex(bytes) != args.digest) {
                return failure(
                    args,
                    initial,
                    "digest-mismatch",
                    "The configuration bytes do not match the admitted digest.",
                )
            }

            val validation = try {
                validator.validate(bytes, args.digest)
            } catch (_: Throwable) {
                return failure(
                    args,
                    repository.current(),
                    "kotlin-exception",
                    "The Android validation adapter failed safely.",
                )
            }
            validationFailure(validation, args, repository.current())?.let { return it }

            val validated = repository.update {
                it.copy(
                    validatedConfigDigest = args.digest,
                    validatedConfigRevision = args.revision,
                )
            }
            if (validated.platformSessionId != initial.platformSessionId) {
                return runtimeReplaced(args, validated)
            }
            if (operation.cancelled.get()) {
                return cancelledBeforeLoad(args, validated)
            }
            if (
                validated.coreConfigState == "loaded" &&
                validated.loadedConfigDigest == args.digest &&
                validated.loadedConfigRevision == args.revision
            ) {
                return result(
                    args = args,
                    facts = validated,
                    outcome = "no-op",
                    message = "The admitted configuration revision is already loaded.",
                )
            }

            val previousLoaded = validated.coreConfigState == "loaded"
            val startedAt = clockMillis()
            val native = try {
                loader.load(bytes, args.digest, args.injectFailure)
            } catch (_: Throwable) {
                NativeConfigLoadResult(NativeLoadCode.JNI_EXCEPTION)
            }
            val timedOut = clockMillis() - startedAt > args.timeoutMillis
            val current = repository.current()
            if (current.platformSessionId != initial.platformSessionId) {
                return runtimeReplaced(args, markUnknown())
            }
            val cancellation = if (operation.cancelled.get()) "too-late" else "not-requested"
            if (native.code == NativeLoadCode.LOADED) {
                val loaded = repository.update {
                    it.copy(
                        coreConfigState = "loaded",
                        loadedConfigDigest = args.digest,
                        loadedConfigRevision = args.revision,
                    )
                }
                return result(
                    args = args,
                    facts = loaded,
                    outcome = if (previousLoaded) "replacement" else "first-load",
                    message = if (timedOut) {
                        "Configuration loaded after the operation deadline; authoritative state was reconciled."
                    } else {
                        "Configuration loaded. VPN and TUN remain unavailable."
                    },
                    cancellation = cancellation,
                    failure = if (timedOut) "timeout" else null,
                    timing = if (timedOut) "timed-out" else "on-time",
                )
            }

            val reconciled = if (native.rollbackGuaranteed) {
                repository.update {
                    if (previousLoaded) it else {
                        it.copy(
                            coreConfigState = "unloaded",
                            loadedConfigDigest = null,
                            loadedConfigRevision = null,
                        )
                    }
                }
            } else {
                markUnknown()
            }
            val failure = mapLoadFailure(native.code)
            return result(
                args = args,
                facts = reconciled,
                outcome = "failed",
                message = if (previousLoaded && native.rollbackGuaranteed) {
                    "Configuration replacement failed; the prior loaded revision was preserved."
                } else if (native.rollbackGuaranteed) {
                    "Configuration load failed; Mobile Core remains unloaded."
                } else {
                    "Loaded Core state is unknown and requires explicit recovery."
                },
                cancellation = cancellation,
                failure = if (timedOut) "timeout" else failure,
                timing = if (timedOut) "timed-out" else "on-time",
                rollback = rollbackFor(reconciled),
            )
        } finally {
            bytes?.fill(0)
            active.compareAndSet(operation, null)
        }
    }

    private fun preflightFailure(
        args: LoadConfigArgs,
        snapshot: MobilePlatformFacts,
    ): MobileConfigLoadResult? {
        if (
            args.sequence != snapshot.factSequence ||
            args.sessionId != snapshot.platformSessionId
        ) {
            return failure(args, snapshot, "stale-authority", "The mobile runtime authority is stale.")
        }
        if (
            args.operationIdOrEmpty().isBlank() ||
            args.operationIdOrEmpty().length > 128 ||
            args.revisionOrEmpty().isBlank() ||
            args.revisionOrEmpty().length > 128 ||
            !args.digestOrEmpty().matches(Regex("^[0-9a-f]{64}$")) ||
            args.timeoutMillis !in 1..MOBILE_CORE_MAX_LOAD_TIMEOUT_MILLIS ||
            (args.injectFailure && !allowFailureInjection)
        ) {
            return failure(
                args,
                snapshot,
                "invalid-input",
                "The configuration load identity is invalid.",
            )
        }
        if (args.configBytes.isEmpty() || args.configBytes.any { it !in 0..255 }) {
            return failure(
                args,
                snapshot,
                "invalid-input",
                "The configuration load input is invalid.",
            )
        }
        if (args.configBytes.size > MOBILE_CORE_MAX_CONFIG_BYTES_V1) {
            return failure(
                args,
                snapshot,
                "configuration-too-large",
                "Configuration exceeds the Mobile Core v1 size limit.",
            )
        }
        if (active.get()?.cancelled?.get() == true) {
            return cancelledBeforeLoad(args, snapshot)
        }
        return null
    }

    private fun validationFailure(
        validation: NativeConfigValidationResult,
        args: LoadConfigArgs,
        snapshot: MobilePlatformFacts,
    ): MobileConfigLoadResult? {
        val mapped = when (validation.code) {
            NativeValidationCode.VALID -> return null
            NativeValidationCode.CONFIG_REJECTED -> "configuration-rejected"
            NativeValidationCode.CONFIG_TOO_LARGE -> "configuration-too-large"
            NativeValidationCode.CORE_UNAVAILABLE -> "core-unavailable"
            NativeValidationCode.INITIALIZATION_FAILED -> "core-initialization-failed"
            NativeValidationCode.MALFORMED_RESPONSE -> "malformed-native-response"
            NativeValidationCode.RESPONSE_TOO_LARGE -> "native-response-too-large"
            NativeValidationCode.JNI_EXCEPTION -> "jni-exception"
            NativeValidationCode.NATIVE_FAILED -> "native-load-rejected"
        }
        return failure(
            args,
            snapshot,
            mapped,
            "Configuration validation failed before Mobile Core loading.",
        )
    }

    private fun cancelledBeforeLoad(
        args: LoadConfigArgs,
        snapshot: MobilePlatformFacts,
    ): MobileConfigLoadResult =
        result(
            args = args,
            facts = snapshot,
            outcome = "cancelled",
            message = "Configuration loading was cancelled before the native load barrier.",
            cancellation = "before-load",
            failure = "cancelled",
            rollback = rollbackFor(snapshot),
        )

    private fun runtimeReplaced(
        args: LoadConfigArgs,
        snapshot: MobilePlatformFacts,
    ): MobileConfigLoadResult =
        result(
            args = args,
            facts = snapshot,
            outcome = "failed",
            message = "The mobile runtime was replaced during configuration loading.",
            failure = "runtime-replaced",
            rollback = rollbackFor(snapshot),
        )

    private fun failure(
        args: LoadConfigArgs,
        snapshot: MobilePlatformFacts,
        failure: String,
        message: String,
    ): MobileConfigLoadResult =
        result(
            args = args,
            facts = snapshot,
            outcome = "failed",
            message = message,
            failure = failure,
            rollback = rollbackFor(snapshot),
        )

    private fun result(
        args: LoadConfigArgs,
        facts: MobilePlatformFacts,
        outcome: String,
        message: String,
        cancellation: String = "not-requested",
        failure: String? = null,
        timing: String = "on-time",
        rollback: String = "not-needed",
    ): MobileConfigLoadResult {
        check(message.length <= 256)
        return MobileConfigLoadResult(
            cancellation = cancellation,
            digest = args.digestOrEmpty(),
            failure = failure,
            message = message,
            operationId = args.operationIdOrEmpty(),
            outcome = outcome,
            revision = args.revisionOrEmpty(),
            rollback = rollback,
            facts = facts,
            timing = timing,
        )
    }

    private fun markUnknown(): MobilePlatformFacts =
        repository.update {
            it.copy(
                coreConfigState = "unknown",
                loadedConfigDigest = null,
                loadedConfigRevision = null,
            )
        }

    private fun consumeCancellation(
        operationId: String,
        operation: ActiveConfigLoad,
    ) {
        synchronized(cancellationTombstones) {
            if (cancellationTombstones.remove(operationId)) operation.cancelled.set(true)
        }
    }

    private fun mapLoadFailure(code: NativeLoadCode): String = when (code) {
        NativeLoadCode.CONFIG_REJECTED -> "configuration-rejected"
        NativeLoadCode.CORE_UNAVAILABLE -> "core-unavailable"
        NativeLoadCode.NOT_INITIALIZED -> "core-initialization-failed"
        NativeLoadCode.MALFORMED_RESPONSE -> "malformed-native-response"
        NativeLoadCode.RESPONSE_TOO_LARGE -> "native-response-too-large"
        NativeLoadCode.JNI_EXCEPTION -> "jni-exception"
        NativeLoadCode.CONFLICT,
        NativeLoadCode.NATIVE_FAILED,
        NativeLoadCode.LOADED,
        -> "native-load-rejected"
    }

    private fun rollbackFor(snapshot: MobilePlatformFacts): String = when (snapshot.coreConfigState) {
        "loaded" -> "preserved"
        "unloaded" -> "unloaded"
        else -> "unknown"
    }
}

private fun LoadConfigArgs.operationIdOrEmpty(): String =
    runCatching { operationId }.getOrDefault("")

private fun LoadConfigArgs.revisionOrEmpty(): String =
    runCatching { revision }.getOrDefault("")

private fun LoadConfigArgs.digestOrEmpty(): String =
    runCatching { digest }.getOrDefault("")

internal fun loadConfigSafely(
    coordinator: MobileConfigLoadCoordinator,
    args: LoadConfigArgs,
    currentSnapshot: () -> MobilePlatformFacts,
): MobileConfigLoadResult =
    runCatching { coordinator.load(args) }
        .getOrElse { loadConfigFailure(args, currentSnapshot(), "kotlin-exception") }

internal fun loadConfigFailure(
    args: LoadConfigArgs,
    snapshot: MobilePlatformFacts,
    failure: String = "plugin-failure",
): MobileConfigLoadResult =
    MobileConfigLoadResult(
        cancellation = "not-requested",
        digest = args.digestOrEmpty(),
        failure = failure,
        message = "The Android configuration load adapter failed safely.",
        operationId = args.operationIdOrEmpty(),
        outcome = "failed",
        revision = args.revisionOrEmpty(),
        rollback = when (snapshot.coreConfigState) {
            "loaded" -> "preserved"
            "unloaded" -> "unloaded"
            else -> "unknown"
        },
        facts = snapshot,
        timing = "on-time",
    )
