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

internal class MishMobileCoreProbe : MobileCoreProbe {
    override fun inspect(): MobileCoreIdentity? {
        if (!shimLoaded) return null
        val abiVersion = runCatching { nativeAbiVersion() }.getOrDefault(0)
        if (abiVersion != CONTRACT_VERSION) return null
        val encoded = runCatching { nativeVersionEnvelope() }.getOrNull() ?: return null
        return parseIdentity(encoded, abiVersion)
    }

    private external fun nativeAbiVersion(): Int

    private external fun nativeVersionEnvelope(): String?

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
    }
}
