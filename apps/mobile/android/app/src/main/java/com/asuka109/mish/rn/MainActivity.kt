package com.asuka109.mish.rn

import com.facebook.react.ReactActivity
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "MishRnHost"

  override fun createReactActivityDelegate(): com.facebook.react.ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName)
}
