package com.asuka109.mish.rn

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class MishCapabilityPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == MishCapabilityModule.NAME) MishCapabilityModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
      ReactModuleInfoProvider {
        mapOf(
            MishCapabilityModule.NAME to
                ReactModuleInfo(
                    MishCapabilityModule.NAME,
                    MishCapabilityModule::class.java.name,
                    false,
                    false,
                    false,
                    true,
                ),
        )
      }
}
