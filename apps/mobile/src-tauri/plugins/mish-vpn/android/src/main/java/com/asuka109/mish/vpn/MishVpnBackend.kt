package com.asuka109.mish.vpn

internal sealed interface BackendStartResult {
    data object Started : BackendStartResult
    data class Failed(val message: String) : BackendStartResult
    data class Unavailable(val message: String) : BackendStartResult
}

internal interface VpnBackend {
    fun start(): BackendStartResult
    fun stop()
}

internal class FixtureVpnBackend : VpnBackend {
    override fun start(): BackendStartResult = BackendStartResult.Unavailable(
        "Fixture lifecycle completed without creating a TUN or starting an embedded Core.",
    )

    override fun stop() = Unit
}
