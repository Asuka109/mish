package com.mish.rnadmission

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class RnAdmissionPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == RnAdmissionModule.NAME) RnAdmissionModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        RnAdmissionModule.NAME to
            ReactModuleInfo(
                RnAdmissionModule.NAME,
                RnAdmissionModule::class.java.name,
                false,
                false,
                false,
                true,
            ),
    )
  }
}
