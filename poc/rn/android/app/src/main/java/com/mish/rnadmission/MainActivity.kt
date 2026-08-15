package com.mish.rnadmission

import com.facebook.react.ReactActivity
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "MishRnAdmission"

  override fun createReactActivityDelegate(): com.facebook.react.ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName)
}
