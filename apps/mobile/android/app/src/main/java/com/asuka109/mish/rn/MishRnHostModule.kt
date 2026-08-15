package com.asuka109.mish.rn

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.module.annotations.ReactModule

/**
 * The only native seam admitted by the RN host. It reports fixed capability
 * facts and never owns product lifecycle, remote cache, UI state, or effects.
 */
@ReactModule(name = MishRnHostModule.NAME)
class MishRnHostModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  /** Return bounded facts only; no permission, process, filesystem, or network call. */
  @com.facebook.react.bridge.ReactMethod
  fun getCapabilities(promise: Promise) {
    val result = Arguments.createMap().apply {
      putString("fixture", "deterministic")
      putBoolean("newArchitecture", true)
      putBoolean("hermes", true)
      putBoolean("vpnEffects", false)
      putBoolean("tunEffects", false)
      putBoolean("coreEffects", false)
      putBoolean("networkEffects", false)
    }
    promise.resolve(result)
  }

  /** Deterministic renderer admission marker; it has no host effect. */
  @com.facebook.react.bridge.ReactMethod
  fun smoke(promise: Promise) {
    promise.resolve("native-capability-ok")
  }

  companion object {
    const val NAME = "MishRnHost"
  }
}
