package com.asuka109.mish

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var installedShellHost: InstalledAndroidShellHost? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    if (BuildConfig.MISH_NATIVE_SHELL_ENABLED) {
      installedShellHost = InstalledAndroidShellHost(this)
    }
    super.onCreate(savedInstanceState)
    installedShellHost?.onActivityIntent(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    installedShellHost?.onWebViewCreated(webView)
  }

  override fun setContentView(view: View?) {
    super.setContentView(
      if (view == null) null else installedShellHost?.wrapTauriWebView(view) ?: view,
    )
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    installedShellHost?.onActivityIntent(intent)
    setIntent(intent)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    installedShellHost?.onConfigurationChanged()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) installedShellHost?.refreshWebBackAffordance()
  }

  override fun onDestroy() {
    installedShellHost?.destroy()
    installedShellHost = null
    super.onDestroy()
  }
}
