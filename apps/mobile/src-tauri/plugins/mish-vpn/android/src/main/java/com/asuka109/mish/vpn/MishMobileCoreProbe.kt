package com.asuka109.mish.vpn

import android.content.Context
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

internal data class CoreLifecycleAuthority(
    val machineAuthority: String,
    val scopeEpoch: Long,
    val operationId: String,
    val admittedRevision: Long,
    val effectIdentity: String,
) {
    fun nextEffect(): CoreLifecycleAuthority? {
        val effect = effectIdentity.toLongOrNull() ?: return null
        if (effect >= ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX) return null
        return copy(effectIdentity = (effect + 1).toString())
    }

    fun isValid(): Boolean =
        machineAuthority.matches(LIFECYCLE_IDENTIFIER_PATTERN) &&
            scopeEpoch in 1..ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX &&
            operationId.matches(LIFECYCLE_IDENTIFIER_PATTERN) &&
            admittedRevision in 1..ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX &&
            effectIdentity.toLongOrNull()?.let { it in 1..ANDROID_PLATFORM_FACTS_SAFE_INTEGER_MAX } == true

    fun toJson(): JSONObject = JSONObject()
        .put("admittedRevision", admittedRevision)
        .put("effectIdentity", effectIdentity)
        .put("machineAuthority", machineAuthority)
        .put("operationId", operationId)
        .put("scopeEpoch", scopeEpoch)

    companion object {
        private val LIFECYCLE_IDENTIFIER_PATTERN = Regex("^[A-Za-z0-9._-]{1,128}$")

        fun fromJson(value: JSONObject): CoreLifecycleAuthority? = runCatching {
            check(value.length() == 5)
            CoreLifecycleAuthority(
                machineAuthority = value.getString("machineAuthority"),
                scopeEpoch = value.getLong("scopeEpoch"),
                operationId = value.getString("operationId"),
                admittedRevision = value.getLong("admittedRevision"),
                effectIdentity = value.getString("effectIdentity"),
            ).takeIf { it.isValid() }
        }.getOrNull()
    }
}

internal fun lifecycleAuthorityIsSuccessor(
    candidate: CoreLifecycleAuthority,
    current: CoreLifecycleAuthority?,
): Boolean {
    if (!candidate.isValid() || current?.isValid() == false) return false
    if (current == null) return true
    if (candidate.machineAuthority != current.machineAuthority) return false
    if (candidate.scopeEpoch != current.scopeEpoch) {
        return candidate.scopeEpoch > current.scopeEpoch
    }
    if (candidate.admittedRevision != current.admittedRevision) {
        return candidate.admittedRevision > current.admittedRevision
    }
    return candidate == current.nextEffect()
}

internal fun lifecycleAuthorityMatchesOrIsSuccessor(
    candidate: CoreLifecycleAuthority,
    current: CoreLifecycleAuthority?,
): Boolean = candidate.isValid() && current?.isValid() != false &&
    (candidate == current || lifecycleAuthorityIsSuccessor(candidate, current))

internal interface MobileCoreRuntime {
    fun start(
        authority: CoreLifecycleAuthority,
        productSessionId: String,
        tunFileDescriptor: Int,
        vpnService: MishVpnService,
    ): NativeRuntimeResult

    fun stop(authority: CoreLifecycleAuthority, productSessionId: String?): NativeRuntimeResult

    fun inspectRuntime(productSessionId: String?): NativeRuntimeResult
}

internal data class NativeRouteOperationResult(
    val commandStatus: Int,
    val commandEnvelope: String?,
    val statusStatus: Int,
    val statusEnvelope: String?,
    val routesStatus: Int,
    val routesEnvelope: String?,
)

internal interface MobileCoreRoutes {
    fun snapshot(): NativeRouteOperationResult
    fun select(
        operationId: String,
        runtimeAuthority: String,
        profileId: String,
        profileRevision: String,
        groupId: String,
        currentChildId: String,
        childId: String,
        nativeGroup: String,
        nativeCurrentChild: String,
        nativeChild: String,
    ): NativeRouteOperationResult
}

internal data class NativeTrafficCloseResult(
    val failure: String?,
    val snapshot: JSONObject,
)

internal interface MobileCoreTrafficAdapter {
    fun snapshotTraffic(): JSONObject?
    fun closeTrafficConnection(connectionId: String, eventSequence: String, sessionId: String): NativeTrafficCloseResult
}

internal class MishMobileCoreProbe internal constructor(
    private val applicationContext: Context? = null,
    private val admissionReader: (() -> MobileCoreAdmissionResult)? = null,
    private val shimLoader: () -> Boolean = ::loadShimOnce,
) :
    MobileCoreProbe,
    MobileCoreConfigValidator,
    MobileCoreConfigLoader,
    MobileCoreConfigInspector,
    MobileCoreRuntime,
    MobileCoreRoutes,
    MobileCoreTrafficAdapter {
    private val admissionLock = Any()
    private val admissionGate = MobileCoreAdmissionGate(::ensureAdmitted)
    private val provenanceProjection = MobileCoreProvenanceProjection()

    internal fun admission(): MobileCoreAdmissionResult =
        admissionGate.check(MobileCoreEffectOperation.ADMISSION)

    internal fun provenanceSnapshot(): MobileCoreProvenanceSnapshot = provenanceProjection.current()

    private fun ensureAdmitted(): MobileCoreAdmissionResult {
        synchronized(admissionLock) {
            if (applicationContext == null && admissionReader == null) {
                return MobileCoreAdmissionResult.rejected(MobileCoreAdmissionFailure.MANIFEST_MISSING)
            }
            val admitted = admissionReader?.invoke()
                ?: MobileCoreArtifactAdmission(checkNotNull(applicationContext)).admit()
            if (!admitted.admitted) return admitted.also(provenanceProjection::publish)
            if (!shimLoader()) {
                return admitted.copy(admitted = false, failure = MobileCoreAdmissionFailure.ARTIFACT_MISSING)
                    .also(provenanceProjection::publish)
            }
            val nativeIdentity = runCatching {
                val abiVersion = nativeAbiVersion()
                val encoded = nativeVersionEnvelope() ?: return@runCatching null
                MishMobileCoreProbe.parseIdentity(encoded, abiVersion)
            }.getOrNull()
            if (!MobileCoreAdmissionPolicy.matchesIdentity(nativeIdentity)) {
                val failure = when {
                    nativeIdentity == null -> MobileCoreAdmissionFailure.ABI_MISMATCH
                    nativeIdentity.commit != MobileCoreAdmissionPolicy.PINNED_SOURCE_COMMIT ->
                        MobileCoreAdmissionFailure.SOURCE_MISMATCH
                    nativeIdentity.version != MobileCoreAdmissionPolicy.PINNED_SOURCE_VERSION ->
                        MobileCoreAdmissionFailure.VERSION_MISMATCH
                    nativeIdentity.wrapperRevision != MobileCoreAdmissionPolicy.PINNED_WRAPPER_REVISION ->
                        MobileCoreAdmissionFailure.WRAPPER_MISMATCH
                    else -> MobileCoreAdmissionFailure.ABI_MISMATCH
                }
                return admitted.copy(admitted = false, failure = failure)
                    .also(provenanceProjection::publish)
            }
            return admitted.also(provenanceProjection::publish)
        }
    }

    override fun inspect(): MobileCoreIdentity? = admissionGate.invoke(
        operation = MobileCoreEffectOperation.INSPECT,
        rejected = { null },
        effect = ::inspectAdmitted,
    )

    private fun inspectAdmitted(): MobileCoreIdentity? {
        val abiVersion = runCatching { nativeAbiVersion() }.getOrDefault(0)
        if (abiVersion != CONTRACT_VERSION) return null
        val encoded = runCatching { nativeVersionEnvelope() }.getOrNull() ?: return null
        return parseIdentity(encoded, abiVersion)?.takeIf(MobileCoreAdmissionPolicy::matchesIdentity)
    }

    private external fun nativeAbiVersion(): Int

    private external fun nativeVersionEnvelope(): String?

    override fun validate(
        configBytes: ByteArray,
        expectedDigest: String,
    ): NativeConfigValidationResult = admissionGate.invoke(
        operation = MobileCoreEffectOperation.VALIDATE,
        rejected = { NativeConfigValidationResult(NativeValidationCode.CORE_UNAVAILABLE) },
        effect = {
            val encoded = try {
                nativeValidateConfig(configBytes, expectedDigest)
            } catch (_: Throwable) {
                return@invoke NativeConfigValidationResult(NativeValidationCode.JNI_EXCEPTION)
            } ?: return@invoke NativeConfigValidationResult(NativeValidationCode.NATIVE_FAILED)
            parseValidation(encoded)
        },
    )

    override fun load(
        configBytes: ByteArray,
        expectedDigest: String,
        injectFailure: Boolean,
    ): NativeConfigLoadResult = admissionGate.invoke(
        operation = MobileCoreEffectOperation.LOAD,
        rejected = { NativeConfigLoadResult(NativeLoadCode.CORE_UNAVAILABLE) },
        effect = {
            if (injectFailure) {
                return@invoke NativeConfigLoadResult(
                    code = NativeLoadCode.NATIVE_FAILED,
                    abiStatus = 8,
                    rollbackGuaranteed = true,
                )
            }
            val encoded = try {
                nativeLoadConfig(configBytes, expectedDigest)
            } catch (_: Throwable) {
                return@invoke NativeConfigLoadResult(NativeLoadCode.JNI_EXCEPTION)
            } ?: return@invoke NativeConfigLoadResult(NativeLoadCode.NATIVE_FAILED)
            parseLoad(encoded)
        },
    )

    override fun inspectLoaded(expectedDigest: String?): NativeConfigInspectionResult = admissionGate.invoke(
        operation = MobileCoreEffectOperation.INSPECT_LOADED,
        rejected = { NativeConfigInspectionResult(NativeInspectionCode.NATIVE_FAILED) },
        effect = {
            val encoded = try {
                nativeInspectLoadedConfig(expectedDigest)
            } catch (_: Throwable) {
                return@invoke NativeConfigInspectionResult(NativeInspectionCode.NATIVE_FAILED)
            } ?: return@invoke NativeConfigInspectionResult(NativeInspectionCode.MALFORMED_RESPONSE)
            parseInspection(encoded)
        },
    )

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
        authority: CoreLifecycleAuthority,
        productSessionId: String,
        tunFileDescriptor: Int,
        vpnService: MishVpnService,
    ): NativeRuntimeResult = runtimeCall(MobileCoreEffectOperation.START) {
        nativeStartCore(
            authority.machineAuthority,
            authority.scopeEpoch,
            authority.operationId,
            authority.admittedRevision,
            authority.effectIdentity,
            productSessionId,
            tunFileDescriptor,
            vpnService,
        )
    }

    override fun stop(
        authority: CoreLifecycleAuthority,
        productSessionId: String?,
    ): NativeRuntimeResult = runtimeCall(MobileCoreEffectOperation.STOP) {
        nativeStopCore(
            authority.machineAuthority,
            authority.scopeEpoch,
            authority.operationId,
            authority.admittedRevision,
            authority.effectIdentity,
            productSessionId,
        )
    }

    override fun inspectRuntime(productSessionId: String?): NativeRuntimeResult = runtimeCall(MobileCoreEffectOperation.INSPECT_RUNTIME) {
        nativeInspectRuntime(productSessionId)
    }

    private fun runtimeCall(
        operation: MobileCoreEffectOperation,
        call: () -> IntArray?,
    ): NativeRuntimeResult = admissionGate.invoke(
        operation = operation,
        rejected = { NativeRuntimeResult(NativeRuntimeCode.CORE_UNAVAILABLE) },
        effect = {
            val encoded = try {
                call()
            } catch (_: Throwable) {
                return@invoke NativeRuntimeResult(NativeRuntimeCode.JNI_EXCEPTION)
            } ?: return@invoke NativeRuntimeResult(NativeRuntimeCode.MALFORMED_RESPONSE)
            parseRuntime(encoded)
        },
    )

    private external fun nativeStartCore(
        machineAuthority: String,
        scopeEpoch: Long,
        operationId: String,
        admittedRevision: Long,
        effectIdentity: String,
        productSessionId: String,
        tunFileDescriptor: Int,
        vpnService: MishVpnService,
    ): IntArray?

    private external fun nativeStopCore(
        machineAuthority: String,
        scopeEpoch: Long,
        operationId: String,
        admittedRevision: Long,
        effectIdentity: String,
        productSessionId: String?,
    ): IntArray?

    private external fun nativeInspectRuntime(productSessionId: String?): IntArray?

    private external fun nativeRouteOperation(commandJson: String?): Array<ByteArray>?

    override fun snapshot(): NativeRouteOperationResult =
        routeOperation(null, null, null, null, null, null, null, null, null, null)

    override fun select(
        operationId: String,
        runtimeAuthority: String,
        profileId: String,
        profileRevision: String,
        groupId: String,
        currentChildId: String,
        childId: String,
        nativeGroup: String,
        nativeCurrentChild: String,
        nativeChild: String,
    ): NativeRouteOperationResult = routeOperation(
        operationId,
        runtimeAuthority,
        profileId,
        profileRevision,
        groupId,
        currentChildId,
        childId,
        nativeGroup,
        nativeCurrentChild,
        nativeChild,
    )

    private fun routeOperation(
        operationId: String?,
        runtimeAuthority: String?,
        profileId: String?,
        profileRevision: String?,
        groupId: String?,
        currentChildId: String?,
        childId: String?,
        nativeGroup: String?,
        nativeCurrentChild: String?,
        nativeChild: String?,
    ): NativeRouteOperationResult =
        admissionGate.invoke(
            operation = MobileCoreEffectOperation.INSPECT_RUNTIME,
            rejected = { NativeRouteOperationResult(8, null, 8, null, 8, null) },
            effect = {
                val command = if (operationId == null) null else JSONObject()
                    .put("operation", "select-policy")
                    .put("operationId", operationId)
                    .put("runtimeAuthority", runtimeAuthority)
                    .put("profileId", profileId)
                    .put("profileRevision", profileRevision)
                    .put("groupId", groupId)
                    .put("currentChildId", currentChildId)
                    .put("childId", childId)
                    .put("group", nativeGroup)
                    .put("currentChild", nativeCurrentChild)
                    .put("selection", nativeChild)
                    .toString()
                val encoded = runCatching { nativeRouteOperation(command) }.getOrNull()
                    ?: return@invoke NativeRouteOperationResult(8, null, 8, null, 8, null)
                if (encoded.size != 6) {
                    return@invoke NativeRouteOperationResult(8, null, 8, null, 8, null)
                }
                NativeRouteOperationResult(
                    commandStatus = strictUtf8(encoded[0])?.toIntOrNull() ?: 8,
                    commandEnvelope = strictUtf8(encoded[1])?.ifEmpty { null },
                    statusStatus = strictUtf8(encoded[2])?.toIntOrNull() ?: 8,
                    statusEnvelope = strictUtf8(encoded[3]),
                    routesStatus = strictUtf8(encoded[4])?.toIntOrNull() ?: 8,
                    routesEnvelope = strictUtf8(encoded[5]),
                )
            },
        )

    override fun snapshotTraffic(): JSONObject? = trafficCall(MobileCoreEffectOperation.TRAFFIC_SNAPSHOT) {
        val encoded = nativeTrafficSnapshot() ?: return@trafficCall null
        parseTrafficSnapshotEnvelope(strictUtf8(encoded) ?: return@trafficCall null)
    }

    override fun closeTrafficConnection(
        connectionId: String,
        eventSequence: String,
        sessionId: String,
    ): NativeTrafficCloseResult = trafficCall(MobileCoreEffectOperation.TRAFFIC_CLOSE) {
        if (!connectionId.matches(Regex("^[A-Za-z0-9._-]{1,128}$"))) {
            return@trafficCall NativeTrafficCloseResult("invalid-request", emptyTrafficSnapshot())
        }
        if (!eventSequence.matches(Regex("^[0-9]{1,20}$")) ||
            !sessionId.matches(Regex("^[A-Za-z0-9._-]{1,128}$"))
        ) {
            return@trafficCall NativeTrafficCloseResult("invalid-request", emptyTrafficSnapshot())
        }
        val encoded = nativeCloseTrafficConnection(connectionId, eventSequence, sessionId)
            ?: return@trafficCall NativeTrafficCloseResult("core-failure", emptyTrafficSnapshot())
        parseNativeCloseResult(strictUtf8(encoded) ?: return@trafficCall NativeTrafficCloseResult(
            "core-failure",
            emptyTrafficSnapshot(),
        ))
            ?: NativeTrafficCloseResult("core-failure", emptyTrafficSnapshot())
    } ?: NativeTrafficCloseResult("core-failure", emptyTrafficSnapshot())

    private fun <T> trafficCall(operation: MobileCoreEffectOperation, call: () -> T?): T? = admissionGate.invoke(
        operation = operation,
        rejected = { null },
        effect = { runCatching(call).getOrNull() },
    )

    private external fun nativeTrafficSnapshot(): ByteArray?

    private external fun nativeCloseTrafficConnection(
        connectionId: String,
        eventSequence: String,
        sessionId: String,
    ): ByteArray?

    companion object {
        @Volatile
        private var shimLoaded = false

        private fun loadShimOnce(): Boolean {
            if (shimLoaded) return true
            return synchronized(this) {
                if (shimLoaded) return@synchronized true
                shimLoaded = runCatching { System.loadLibrary("mish_vpn_jni") }.isSuccess
                shimLoaded
            }
        }

        internal fun parseIdentity(encoded: String, abiVersion: Int): MobileCoreIdentity? =
            runCatching {
                val root = JSONObject(encoded)
                requireJsonKeys(root, setOf("abiVersion", "data"))
                if (root.optInt("abiVersion") != CONTRACT_VERSION) return null
                val data = root.getJSONObject("data")
                requireJsonKeys(data, setOf("abiVersion", "goVersion", "mihomoCommit", "mihomoVersion", "wrapperRevision"))
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

        private fun requireJsonKeys(value: JSONObject, expected: Set<String>) {
            require(value.length() == expected.size)
            val actual = mutableSetOf<String>()
            val keys = value.keys()
            while (keys.hasNext()) actual += keys.next()
            require(actual == expected)
        }

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

        internal fun parseTrafficSnapshotEnvelope(encoded: String): JSONObject? = runCatching {
            val root = JSONObject(encoded)
            requireJsonKeys(root, setOf("abiVersion", "data"))
            check(root.getInt("abiVersion") == CONTRACT_VERSION)
            root.getJSONObject("data")
        }.getOrNull()

        internal fun parseNativeCloseResult(encoded: String): NativeTrafficCloseResult? = runCatching {
            val root = JSONObject(encoded)
            requireJsonKeys(root, setOf("abiVersion", "data"))
            check(root.getInt("abiVersion") == CONTRACT_VERSION)
            val data = root.getJSONObject("data")
            requireJsonKeys(data, setOf("failure", "snapshot"))
            val failure = data.takeUnless { it.isNull("failure") }?.getString("failure")
            check(failure == null || failure in setOf("invalid-request", "stale-connection", "core-failure"))
            NativeTrafficCloseResult(failure, data.getJSONObject("snapshot"))
        }.getOrNull()

        internal fun strictUtf8(bytes: ByteArray): String? = runCatching {
            bytes.toString(Charsets.UTF_8).also {
                require(it.toByteArray(Charsets.UTF_8).contentEquals(bytes))
            }
        }.getOrNull()

        internal fun emptyTrafficSnapshot(): JSONObject = JSONObject()
            .put("connections", org.json.JSONArray())
            .put("eventSequence", "0")
            .put("running", false)
            .put("sessionId", "unavailable")
            .put("truncated", false)
    }
}
