package com.asuka109.mish

import android.animation.ValueAnimator
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.net.Uri
import android.view.Menu
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.content.res.AppCompatResources
import androidx.core.content.IntentCompat
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.color.MaterialColors
import com.google.android.material.navigation.NavigationBarView
import com.google.android.material.shape.ShapeAppearanceModel
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt

/**
 * Installed-Android Material chrome around the one WebView created and retained by Tauri.
 *
 * Native input is closed before it reaches Shared Rust. Rust snapshots are the only selected-state
 * writer, and the WebView receives one-way entry directives without a script message interface,
 * Tauri shell command, URL command handler, or acknowledgement channel.
 */
class InstalledAndroidShellHost(private val activity: MainActivity) {
  private var active = false
  private var renderingSnapshot = false
  private var root: LinearLayout? = null
  private var toolbar: MaterialToolbar? = null
  private var navigation: BottomNavigationView? = null
  private var webView: WebView? = null
  private var currentSnapshot: ShellSnapshot? = null
  private var documentStartScript: ScriptHandler? = null
  private var pendingIntent: Intent? = null
  private var disabledDestinationForTesting: ShellDestination? = null
  private var lastDeliveredKey: String? = null
  private var drawListener: ViewTreeObserver.OnDrawListener? = null
  private var backPreviewActive = false
  private var backUpdatePosted = false
  private val intentSequence = AtomicLong()

  private val backCallback = object : OnBackPressedCallback(false) {
    override fun handleOnBackStarted(backEvent: BackEventCompat) {
      backPreviewActive = webView?.canGoBack() == true
      applyBackPreview(if (backPreviewActive) backEvent.progress else 0f)
    }

    override fun handleOnBackProgressed(backEvent: BackEventCompat) {
      if (backPreviewActive) applyBackPreview(backEvent.progress)
    }

    override fun handleOnBackCancelled() {
      backPreviewActive = false
      applyBackPreview(0f)
    }

    override fun handleOnBackPressed() {
      backPreviewActive = false
      applyBackPreview(0f)
      val attachedWebView = webView ?: return
      if (attachedWebView.canGoBack()) {
        attachedWebView.goBack()
        attachedWebView.post(::refreshWebBackAffordance)
      } else {
        isEnabled = false
        activity.onBackPressedDispatcher.onBackPressed()
      }
    }
  }

  fun onWebViewCreated(createdWebView: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    val snapshot = runCatching { parseEnvelope(NativeShellBridge.snapshot()).snapshot }.getOrNull()
      ?: return

    active = true
    webView = createdWebView
    currentSnapshot = snapshot
    installDocumentStartProjection(snapshot)
    lastDeliveredKey = deliveryKey(snapshot.authorityId, snapshot.revision, createdWebView)
    installWebHistoryObserver(createdWebView)
    activity.onBackPressedDispatcher.addCallback(activity, backCallback)
    pendingIntent?.also(::handleActivityIntent)
    pendingIntent = null
  }

  fun wrapTauriWebView(view: View): View {
    if (!active || view !== webView) return view
    root?.let { return it }

    val attachedWebView = webView ?: return view
    (attachedWebView.parent as? ViewGroup)?.removeView(attachedWebView)
    val appBar = MaterialToolbar(activity).apply {
      id = R.id.native_shell_app_bar
      minimumHeight = dp(64)
      isTitleCentered = false
      setNavigationOnClickListener {
        if (backCallback.isEnabled) backCallback.handleOnBackPressed()
      }
    }
    val webContainer = FrameLayout(activity).apply {
      id = R.id.native_shell_web_container
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      addView(
        attachedWebView,
        FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT,
        ),
      )
    }
    val bottomNavigation = BottomNavigationView(activity).apply {
      id = R.id.native_shell_bottom_navigation
      labelVisibilityMode = NavigationBarView.LABEL_VISIBILITY_LABELED
      itemIconSize = dp(24)
      setItemActiveIndicatorEnabled(true)
      itemActiveIndicatorWidth = dp(64)
      itemActiveIndicatorHeight = dp(32)
      itemActiveIndicatorShapeAppearance =
        ShapeAppearanceModel.builder().setAllCornerSizes(dp(18).toFloat()).build()
      minimumHeight = dp(80)
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    ShellDestination.entries.forEach { destination ->
      bottomNavigation.menu.add(Menu.NONE, destination.menuId, destination.order, label(destination))
        .setIcon(destination.icon)
        .also { item ->
          item.isCheckable = true
          item.contentDescription = label(destination)
        }
    }
    bottomNavigation.setOnItemSelectedListener { item ->
      if (renderingSnapshot) return@setOnItemSelectedListener true
      if (!item.isEnabled) return@setOnItemSelectedListener false
      val destination = ShellDestination.fromMenuId(item.itemId)
        ?: return@setOnItemSelectedListener false
      selectDestination(destination)
      true
    }
    bottomNavigation.setOnItemReselectedListener { item ->
      announceNavigationReselection(
        bottomNavigation,
        activity.getString(R.string.native_shell_destination_reselected, item.title),
      )
    }

    val shellRoot = LinearLayout(activity).apply {
      id = R.id.native_shell_root
      orientation = LinearLayout.VERTICAL
      clipChildren = false
      clipToPadding = false
      addView(
        appBar,
        LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        ),
      )
      addView(
        webContainer,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
      )
      addView(
        bottomNavigation,
        LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        ),
      )
    }

    root = shellRoot
    toolbar = appBar
    navigation = bottomNavigation
    configureInsets(shellRoot, appBar, bottomNavigation)
    applyMaterialColors()
    currentSnapshot?.let(::renderSnapshot)
    applyDebugDisabledDestination()
    ViewCompat.requestApplyInsets(shellRoot)
    return shellRoot
  }

  fun onActivityIntent(intent: Intent) {
    if (!active) {
      pendingIntent = Intent(intent)
      return
    }
    handleActivityIntent(intent)
  }

  fun onConfigurationChanged() {
    if (!active) return
    applyMaterialColors()
    root?.let(ViewCompat::requestApplyInsets)
  }

  fun refreshWebBackAffordance() {
    if (!active) return
    val canGoBack = webView?.canGoBack() == true
    backCallback.isEnabled = canGoBack
    toolbar?.apply {
      navigationIcon = if (canGoBack) {
        AppCompatResources.getDrawable(activity, R.drawable.ic_native_shell_back)
      } else {
        null
      }
      navigationContentDescription = if (canGoBack) {
        activity.getString(R.string.native_shell_back)
      } else {
        null
      }
    }
  }

  fun destroy() {
    drawListener?.let { listener ->
      webView?.viewTreeObserver?.takeIf(ViewTreeObserver::isAlive)?.removeOnDrawListener(listener)
    }
    drawListener = null
    documentStartScript?.remove()
    documentStartScript = null
    backCallback.remove()
    applyBackPreview(0f)
    webView = null
    toolbar = null
    navigation = null
    root = null
    active = false
  }

  private fun handleActivityIntent(intent: Intent) {
    if (BuildConfig.DEBUG) {
      disabledDestinationForTesting = intent.getStringExtra(EXTRA_DISABLED_DESTINATION_FOR_TESTING)
        ?.let(ShellDestination::fromWireName)
      applyDebugDisabledDestination()
    }
    val webEntryPath = validatedDeepLink(intent) ?: return
    val snapshot = currentSnapshot ?: return
    val envelope = runCatching {
      parseEnvelope(
        NativeShellBridge.openDeepLink(
          webEntryPath,
          snapshot.revision,
          nextIntentId("deep-link"),
        ),
      )
    }.getOrNull() ?: return
    renderEnvelope(envelope)
  }

  private fun selectDestination(destination: ShellDestination) {
    val snapshot = currentSnapshot ?: return
    val envelope = runCatching {
      parseEnvelope(
        NativeShellBridge.selectDestination(
          destination.wireName,
          snapshot.revision,
          nextIntentId("chrome"),
        ),
      )
    }.getOrNull() ?: run {
      renderSnapshot(snapshot)
      return
    }
    renderEnvelope(envelope)
  }

  private fun renderEnvelope(envelope: ShellEnvelope) {
    renderSnapshot(envelope.snapshot)
    installDocumentStartProjection(envelope.snapshot)
    if (envelope.status == "applied") {
      envelope.directive?.let(::deliverDirective)
    }
  }

  private fun renderSnapshot(snapshot: ShellSnapshot) {
    currentSnapshot = snapshot
    val destination = ShellDestination.fromWireName(snapshot.selectedDestination) ?: return
    toolbar?.title = label(destination)
    navigation?.let { bottomNavigation ->
      renderingSnapshot = true
      bottomNavigation.selectedItemId = destination.menuId
      renderingSnapshot = false
    }
    refreshWebBackAffordance()
  }

  private fun installDocumentStartProjection(snapshot: ShellSnapshot) {
    val attachedWebView = webView ?: return
    documentStartScript?.remove()
    val entry = snapshot.toWebEntryJson()
    val script = """
      (() => {
        const entry = Object.freeze(JSON.parse(${JSONObject.quote(entry.toString())}));
        Object.defineProperty(window, "__MISH_INSTALLED_ANDROID_SHELL__", {
          configurable: false,
          enumerable: false,
          value: true,
          writable: false,
        });
        history.replaceState(history.state, "", entry.webEntryPath);
        window.__MISH_ANDROID_SHELL_PENDING__ = [entry];
      })();
    """.trimIndent()
    documentStartScript = WebViewCompat.addDocumentStartJavaScript(
      attachedWebView,
      script,
      setOf("*"),
    )
  }

  private fun deliverDirective(directive: ShellDirective) {
    val attachedWebView = webView ?: return
    val key = deliveryKey(directive.authorityId, directive.revision, attachedWebView)
    if (lastDeliveredKey == key) return
    lastDeliveredKey = key
    val entry = directive.toWebEntryJson()
    attachedWebView.evaluateJavascript(
      """
        (() => {
          const entry = Object.freeze(JSON.parse(${JSONObject.quote(entry.toString())}));
          const apply = window.__MISH_APPLY_ANDROID_SHELL_ENTRY__;
          if (typeof apply === "function") apply(entry);
          else window.__MISH_ANDROID_SHELL_PENDING__ = [entry];
        })();
      """.trimIndent(),
      null,
    )
  }

  private fun installWebHistoryObserver(attachedWebView: WebView) {
    val listener = ViewTreeObserver.OnDrawListener {
      if (backUpdatePosted) return@OnDrawListener
      backUpdatePosted = true
      attachedWebView.post {
        backUpdatePosted = false
        refreshWebBackAffordance()
      }
    }
    drawListener = listener
    attachedWebView.viewTreeObserver.addOnDrawListener(listener)
  }

  private fun configureInsets(
    shellRoot: View,
    appBar: MaterialToolbar,
    bottomNavigation: BottomNavigationView,
  ) {
    val appBarBaseLeft = appBar.paddingLeft
    val appBarBaseTop = appBar.paddingTop
    val appBarBaseRight = appBar.paddingRight
    val appBarBaseBottom = appBar.paddingBottom
    val navigationBaseLeft = bottomNavigation.paddingLeft
    val navigationBaseTop = bottomNavigation.paddingTop
    val navigationBaseRight = bottomNavigation.paddingRight
    val navigationBaseBottom = bottomNavigation.paddingBottom
    val rootBaseLeft = shellRoot.paddingLeft
    val rootBaseTop = shellRoot.paddingTop
    val rootBaseRight = shellRoot.paddingRight
    val rootBaseBottom = shellRoot.paddingBottom
    val handledTypes = WindowInsetsCompat.Type.systemBars() or
      WindowInsetsCompat.Type.displayCutout()
    val imeType = WindowInsetsCompat.Type.ime()

    fun applyShellInsets(windowInsets: WindowInsetsCompat): WindowInsetsCompat {
      val systemInsets = windowInsets.getInsets(handledTypes)
      val imeInsets = windowInsets.getInsets(imeType)
      val imeVisible = windowInsets.isVisible(imeType) && imeInsets.bottom > 0
      shellRoot.setPadding(
        rootBaseLeft,
        rootBaseTop,
        rootBaseRight,
        rootBaseBottom + if (imeVisible) imeInsets.bottom else 0,
      )
      appBar.setPadding(
        appBarBaseLeft + systemInsets.left,
        appBarBaseTop + systemInsets.top,
        appBarBaseRight + systemInsets.right,
        appBarBaseBottom,
      )
      appBar.minimumHeight = dp(64) + systemInsets.top
      bottomNavigation.setPadding(
        navigationBaseLeft + systemInsets.left,
        navigationBaseTop,
        navigationBaseRight + systemInsets.right,
        navigationBaseBottom + if (imeVisible) 0 else systemInsets.bottom,
      )
      bottomNavigation.minimumHeight = dp(80) + if (imeVisible) 0 else systemInsets.bottom
      return WindowInsetsCompat.Builder(windowInsets)
        .setInsets(handledTypes or imeType, Insets.NONE)
        .build()
    }
    ViewCompat.setOnApplyWindowInsetsListener(shellRoot) { _, windowInsets ->
      applyShellInsets(windowInsets)
    }
    ViewCompat.setWindowInsetsAnimationCallback(
      shellRoot,
      object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
        override fun onProgress(
          insets: WindowInsetsCompat,
          runningAnimations: MutableList<WindowInsetsAnimationCompat>,
        ): WindowInsetsCompat = applyShellInsets(insets)
      },
    )
  }

  private fun applyMaterialColors() {
    val appBar = toolbar ?: return
    val bottomNavigation = navigation ?: return
    val surface = MaterialColors.getColor(appBar, com.google.android.material.R.attr.colorSurface)
    val surfaceContainer = MaterialColors.getColor(
      bottomNavigation,
      com.google.android.material.R.attr.colorSurfaceContainer,
    )
    val onSurface = MaterialColors.getColor(appBar, com.google.android.material.R.attr.colorOnSurface)
    val onSurfaceVariant = MaterialColors.getColor(
      bottomNavigation,
      com.google.android.material.R.attr.colorOnSurfaceVariant,
    )
    val primary = MaterialColors.getColor(bottomNavigation, com.google.android.material.R.attr.colorPrimary)
    val secondaryContainer = MaterialColors.getColor(
      bottomNavigation,
      com.google.android.material.R.attr.colorSecondaryContainer,
    )
    val itemColors = ColorStateList(
      arrayOf(
        intArrayOf(-android.R.attr.state_enabled),
        intArrayOf(android.R.attr.state_checked),
        intArrayOf(),
      ),
      intArrayOf(
        ColorUtils.setAlphaComponent(onSurface, (255 * 0.38f).roundToInt()),
        primary,
        onSurfaceVariant,
      ),
    )
    val ripple = ColorStateList(
      arrayOf(
        intArrayOf(android.R.attr.state_pressed),
        intArrayOf(android.R.attr.state_focused),
        intArrayOf(),
      ),
      intArrayOf(
        ColorUtils.setAlphaComponent(onSurface, (255 * 0.12f).roundToInt()),
        ColorUtils.setAlphaComponent(onSurface, (255 * 0.12f).roundToInt()),
        Color.TRANSPARENT,
      ),
    )
    root?.setBackgroundColor(surface)
    appBar.setBackgroundColor(surface)
    appBar.setTitleTextColor(onSurface)
    bottomNavigation.setBackgroundColor(surfaceContainer)
    bottomNavigation.itemIconTintList = itemColors
    bottomNavigation.itemTextColor = itemColors
    bottomNavigation.itemRippleColor = ripple
    bottomNavigation.itemActiveIndicatorColor = ColorStateList.valueOf(secondaryContainer)
  }

  private fun applyBackPreview(progress: Float) {
    val attachedWebView = webView ?: return
    if (!ValueAnimator.areAnimatorsEnabled()) {
      attachedWebView.translationX = 0f
      attachedWebView.scaleX = 1f
      attachedWebView.scaleY = 1f
      return
    }
    val bounded = progress.coerceIn(0f, 1f)
    attachedWebView.translationX = dp(24) * bounded
    attachedWebView.scaleX = 1f - (bounded * 0.02f)
    attachedWebView.scaleY = 1f - (bounded * 0.02f)
  }

  private fun validatedDeepLink(intent: Intent): String? {
    if (intent.action != Intent.ACTION_VIEW) return null
    if (intent.component?.packageName != activity.packageName) return null
    if (intent.categories?.contains(Intent.CATEGORY_BROWSABLE) != true) return null
    val uri = intent.data ?: return null
    if (uri.scheme != DEEP_LINK_SCHEME || uri.host != DEEP_LINK_HOST) return null
    if (uri.port != -1 || uri.encodedUserInfo != null || uri.encodedFragment != null) return null
    val exactReferrer = IntentCompat.getParcelableExtra(
      intent,
      Intent.EXTRA_REFERRER,
      Uri::class.java,
    ) ?: intent.getStringExtra(Intent.EXTRA_REFERRER_NAME)?.let(Uri::parse)
      ?: activity.referrer.takeIf { intent === activity.intent }
    if (isSelfOriginatedReferrer(exactReferrer)) return null
    if (exactReferrer == null && !isDebugExternalDeepLink(intent)) return null
    val path = uri.encodedPath ?: return null
    val query = uri.encodedQuery
    return if (query == null) path else "$path?$query"
  }

  private fun isSelfOriginatedReferrer(referrer: Uri?): Boolean =
    referrer?.scheme == "android-app" && referrer.host == activity.packageName

  private fun isDebugExternalDeepLink(intent: Intent): Boolean =
    BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_EXTERNAL_DEEP_LINK_FOR_TESTING, false)

  private fun applyDebugDisabledDestination() {
    val bottomNavigation = navigation ?: return
    ShellDestination.entries.forEach { destination ->
      bottomNavigation.menu.findItem(destination.menuId)?.isEnabled =
        destination != disabledDestinationForTesting
    }
  }

  private fun label(destination: ShellDestination): String = activity.getString(destination.label)

  @Suppress("DEPRECATION")
  private fun announceNavigationReselection(view: View, message: CharSequence) {
    view.announceForAccessibility(message)
  }

  private fun nextIntentId(kind: String): String =
    "android-$kind-${intentSequence.incrementAndGet()}"

  private fun dp(value: Int): Int = (value * activity.resources.displayMetrics.density).roundToInt()

  private fun deliveryKey(authorityId: String, revision: Long, attachedWebView: WebView): String =
    "$authorityId:$revision:${System.identityHashCode(attachedWebView)}"

  private fun parseEnvelope(json: String): ShellEnvelope {
    val objectValue = JSONObject(json)
    return ShellEnvelope(
      status = objectValue.getString("status"),
      snapshot = parseSnapshot(objectValue.getJSONObject("snapshot")),
      directive = objectValue.optJSONObject("directive")?.let(::parseDirective),
    )
  }

  private fun parseSnapshot(value: JSONObject): ShellSnapshot = ShellSnapshot(
    authorityId = value.getString("authorityId"),
    revision = value.getLong("revision"),
    selectedDestination = value.getString("selectedDestination"),
    webEntryPath = value.getString("webEntryPath"),
  )

  private fun parseDirective(value: JSONObject): ShellDirective = ShellDirective(
    authorityId = value.getString("authorityId"),
    revision = value.getLong("revision"),
    webEntryPath = value.getString("webEntryPath"),
  )

  companion object {
    private const val DEEP_LINK_SCHEME = "mish"
    private const val DEEP_LINK_HOST = "app"
    private const val EXTRA_DISABLED_DESTINATION_FOR_TESTING =
      "com.asuka109.mish.test.DISABLED_DESTINATION"
    private const val EXTRA_EXTERNAL_DEEP_LINK_FOR_TESTING =
      "com.asuka109.mish.test.EXTERNAL_DEEP_LINK"
  }
}

private enum class ShellDestination(
  val wireName: String,
  val menuId: Int,
  val order: Int,
  val label: Int,
  val icon: Int,
) {
  HOME("home", R.id.native_shell_home, 0, R.string.mobile_navigation_home, R.drawable.ic_native_shell_home),
  ROUTES("routes", R.id.native_shell_routes, 1, R.string.mobile_navigation_routes, R.drawable.ic_native_shell_routes),
  PROFILES("profiles", R.id.native_shell_profiles, 2, R.string.mobile_navigation_profiles, R.drawable.ic_native_shell_profiles),
  ACTIVITY("activity", R.id.native_shell_activity, 3, R.string.mobile_navigation_activity, R.drawable.ic_native_shell_activity),
  SETTINGS("settings", R.id.native_shell_settings, 4, R.string.mobile_navigation_settings, R.drawable.ic_native_shell_settings);

  companion object {
    fun fromMenuId(menuId: Int): ShellDestination? = entries.firstOrNull { it.menuId == menuId }

    fun fromWireName(wireName: String): ShellDestination? =
      entries.firstOrNull { it.wireName == wireName }
  }
}

private data class ShellEnvelope(
  val status: String,
  val snapshot: ShellSnapshot,
  val directive: ShellDirective?,
)

private data class ShellSnapshot(
  val authorityId: String,
  val revision: Long,
  val selectedDestination: String,
  val webEntryPath: String,
) {
  fun toWebEntryJson(): JSONObject = JSONObject().apply {
    put("authorityId", authorityId)
    put("revision", revision)
    put("webEntryPath", webEntryPath)
  }
}

private data class ShellDirective(
  val authorityId: String,
  val revision: Long,
  val webEntryPath: String,
) {
  fun toWebEntryJson(): JSONObject = JSONObject().apply {
    put("authorityId", authorityId)
    put("revision", revision)
    put("webEntryPath", webEntryPath)
  }
}
