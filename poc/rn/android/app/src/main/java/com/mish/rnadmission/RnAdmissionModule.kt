package com.mish.rnadmission

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.turbomodule.core.interfaces.TurboModule

@ReactModule(name = RnAdmissionModule.NAME)
class RnAdmissionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), TurboModule {
  override fun getName(): String = NAME

  override fun initialize() = Unit

  override fun invalidate() = Unit

  /** Return only fixed capability facts; this seam never touches a host effect. */
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

  /** Deterministic native smoke marker; no filesystem, process, or network call. */
  @com.facebook.react.bridge.ReactMethod
  fun smoke(promise: Promise) {
    promise.resolve("native-capability-ok")
  }

  companion object {
    const val NAME = "MishRnAdmission"
  }
}
