package com.asuka109.mish.rn

import com.asuka109.mish.rn.NativeMishCapabilitySpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

class MishCapabilityModule(reactContext: ReactApplicationContext) :
    NativeMishCapabilitySpec(reactContext) {
  override fun getName(): String = NAME

  override fun getSnapshot(promise: Promise) {
    promise.resolve(MishCapabilityContract.snapshot().payload)
  }

  override fun requestCapability(capability: String, requestId: String, promise: Promise) {
    promise.resolve(MishCapabilityContract.request(capability, requestId).payload)
  }

  companion object {
    const val NAME = "MishCapability"
  }
}
