package com.asuka109.mish.rn

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class MishRnHostPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == MishRnHostModule.NAME) MishRnHostModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        MishRnHostModule.NAME to
            ReactModuleInfo(
                MishRnHostModule.NAME,
                MishRnHostModule::class.java.name,
                false,
                false,
                false,
                false,
            ),
    )
  }
}
