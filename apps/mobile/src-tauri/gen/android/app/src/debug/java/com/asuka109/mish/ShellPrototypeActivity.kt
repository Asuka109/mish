package com.asuka109.mish

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.color.MaterialColors
import com.google.android.material.navigation.NavigationBarView
import com.google.android.material.appbar.MaterialToolbar
import org.json.JSONObject
import java.util.UUID
import android.window.BackEvent
import android.window.OnBackAnimationCallback
import android.window.OnBackInvokedDispatcher

/**
 * Debug-only host prototype for Issue #343.
 *
 * The native bar and WebView never own parallel selected-route stores. A small
 * in-process authority stands in for the tested Shared Rust prototype and emits
 * a complete revisioned snapshot to both projections after every intent.
 */
class ShellPrototypeActivity : AppCompatActivity() {
  private lateinit var toolbar: MaterialToolbar
  private lateinit var webView: WebView
  private lateinit var navigation: BottomNavigationView
  private lateinit var navigationInsetSpacer: View
  private val authority = PrototypeNavigationAuthority()
  private var currentSnapshot = authority.snapshot()
  private var renderingSnapshot = false
  private var predictiveBackCallback: OnBackAnimationCallback? = null
  private var predictiveBackRegistered = false
  private var legacyBackCallback: OnBackPressedCallback? = null
  private var profilesEnabled = true

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    setContentView(buildContent())
    configureToolbar()
    configureNavigation()
    configureInsets()
    configureBack()
    configureWebView()

    val deepLink = intent.getStringExtra(EXTRA_PROTOTYPE_ROUTE)
    if (deepLink != null) {
      authority.openPath(
        deepLink,
        currentSnapshot.revision,
        "deep-link-${UUID.randomUUID()}",
      )?.let(::render)
    } else {
      render(currentSnapshot)
    }
  }

  override fun onDestroy() {
    if (Build.VERSION.SDK_INT >= 34 && predictiveBackRegistered) {
      predictiveBackCallback?.let(onBackInvokedDispatcher::unregisterOnBackInvokedCallback)
    }
    webView.removeJavascriptInterface(JS_BRIDGE_NAME)
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    intent.getStringExtra(EXTRA_PROTOTYPE_ROUTE)?.let { path ->
      authority.openPath(
        path,
        currentSnapshot.revision,
        "deep-link-${UUID.randomUUID()}",
      )?.let(::render)
    }
  }

  private fun buildContent(): View {
    toolbar = MaterialToolbar(this).apply {
      id = View.generateViewId()
      title = "Home"
      subtitle = "Rust-authority projection"
      minimumHeight = dp(56)
    }
    webView = WebView(this).apply {
      id = View.generateViewId()
      isFocusable = true
      isFocusableInTouchMode = true
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    navigation = BottomNavigationView(this).apply {
      id = View.generateViewId()
      labelVisibilityMode = NavigationBarView.LABEL_VISIBILITY_LABELED
      itemIconTintList = null
      minimumHeight = dp(64)
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
      addDestination(ID_HOME, "Home", android.R.drawable.ic_menu_view)
      addDestination(ID_ROUTES, "Routes", android.R.drawable.ic_menu_directions)
      addDestination(ID_PROFILES, "Profiles", android.R.drawable.ic_menu_agenda)
      addDestination(ID_ACTIVITY, "Activity", android.R.drawable.ic_menu_recent_history)
      addDestination(ID_SETTINGS, "Settings", android.R.drawable.ic_menu_preferences)
    }
    navigationInsetSpacer = View(this)
    val navigationRegion = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSurface))
      addView(
        navigation,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
      addView(
        navigationInsetSpacer,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0),
      )
    }

    return LinearLayout(this).apply {
      id = View.generateViewId()
      orientation = LinearLayout.VERTICAL
      addView(
        toolbar,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
      addView(
        webView,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
      )
      addView(
        navigationRegion,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
    }
  }

  private fun BottomNavigationView.addDestination(id: Int, label: String, icon: Int) {
    menu.add(Menu.NONE, id, Menu.NONE, label).apply {
      setIcon(icon)
      contentDescription = label
      isCheckable = true
    }
  }

  private fun configureToolbar() {
    toolbar.setNavigationOnClickListener {
      commitBack(currentSnapshot.revision, "top-app-bar")
    }
    toolbar.menu.add("Sheet").apply {
      setIcon(android.R.drawable.ic_menu_more)
      setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
      contentDescription = "Open native sheet"
    }
    toolbar.menu.add("Disable Profiles")
    toolbar.menu.add("Toggle appearance")
    toolbar.setOnMenuItemClickListener { item ->
      when (item.title.toString()) {
        "Sheet" -> showNativeSheet()
        "Disable Profiles" -> {
          profilesEnabled = !profilesEnabled
          navigation.menu.findItem(ID_PROFILES).isEnabled = profilesEnabled
          item.title = if (profilesEnabled) "Disable Profiles" else "Enable Profiles"
        }
        "Toggle appearance" -> toggleAppearance()
        else -> return@setOnMenuItemClickListener false
      }
      true
    }
  }

  private fun configureNavigation() {
    navigation.setOnItemSelectedListener { item ->
      if (renderingSnapshot) return@setOnItemSelectedListener true
      val tab = PrototypeTab.fromMenuId(item.itemId) ?: return@setOnItemSelectedListener false
      authority.selectTab(
        tab,
        currentSnapshot.revision,
        "android-tab-${UUID.randomUUID()}",
      )?.let(::render)
      true
    }
    navigation.setOnItemReselectedListener {
      announce("${it.title} is already selected")
    }
  }

  private fun configureInsets() {
    val root = toolbar.parent as View
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, windowInsets ->
      val handledTypes =
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val systemInsets = windowInsets.getInsets(handledTypes)
      toolbar.setPadding(
        toolbar.paddingLeft,
        systemInsets.top,
        toolbar.paddingRight,
        toolbar.paddingBottom,
      )
      toolbar.minimumHeight = dp(56) + systemInsets.top
      navigation.setPadding(
        systemInsets.left,
        navigation.paddingTop,
        systemInsets.right,
        0,
      )
      navigation.minimumHeight = dp(64)
      navigationInsetSpacer.layoutParams = navigationInsetSpacer.layoutParams.apply {
        height = systemInsets.bottom
      }
      WindowInsetsCompat.Builder(windowInsets)
        .setInsets(handledTypes, Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(root)
  }

  private fun configureBack() {
    if (Build.VERSION.SDK_INT >= 34) {
      val callback = object : OnBackAnimationCallback {
        private var expectedRevision = 0L

        override fun onBackStarted(backEvent: BackEvent) {
          expectedRevision = currentSnapshot.revision
          previewBack(0f)
        }

        override fun onBackProgressed(backEvent: BackEvent) {
          previewBack(backEvent.progress)
        }

        override fun onBackCancelled() {
          previewBack(0f)
        }

        override fun onBackInvoked() {
          previewBack(0f)
          commitBack(expectedRevision, "predictive-back")
        }
      }
      predictiveBackCallback = callback
    } else {
      val callback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
          commitBack(currentSnapshot.revision, "dispatcher-back")
        }
      }
      legacyBackCallback = callback
      onBackPressedDispatcher.addCallback(this, callback)
    }
  }

  @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
  private fun configureWebView() {
    webView.settings.javaScriptEnabled = true
    webView.settings.domStorageEnabled = false
    webView.webViewClient = object : WebViewClient() {
      override fun onPageFinished(view: WebView, url: String) {
        render(currentSnapshot)
      }
    }
    webView.addJavascriptInterface(WebRouteBridge(), JS_BRIDGE_NAME)
    webView.loadDataWithBaseURL(
      "https://prototype.mish.invalid/",
      PROTOTYPE_HTML,
      "text/html",
      "utf-8",
      null,
    )
  }

  private fun render(snapshot: PrototypeNavigationSnapshot) {
    currentSnapshot = snapshot
    renderingSnapshot = true
    navigation.selectedItemId = snapshot.selectedTab.menuId
    renderingSnapshot = false
    toolbar.title = snapshot.title
    toolbar.navigationIcon =
      if (snapshot.canGoBack) getDrawable(androidx.appcompat.R.drawable.abc_ic_ab_back_material)
      else null
    toolbar.navigationContentDescription = if (snapshot.canGoBack) "Back" else null
    updateBackRegistration(snapshot.canGoBack)
    val motion = ValueAnimator.areAnimatorsEnabled()
    toolbar.subtitle =
      "revision ${snapshot.revision} · ${if (motion) "motion" else "reduced motion"}"
    val encoded = JSONObject.quote(snapshot.toJson().toString())
    webView.evaluateJavascript(
      "window.routeProjection && window.routeProjection.apply(JSON.parse($encoded));",
      null,
    )
  }

  private fun updateBackRegistration(canGoBack: Boolean) {
    if (Build.VERSION.SDK_INT >= 34) {
      val callback = predictiveBackCallback ?: return
      if (canGoBack && !predictiveBackRegistered) {
        onBackInvokedDispatcher.registerOnBackInvokedCallback(
          OnBackInvokedDispatcher.PRIORITY_DEFAULT,
          callback,
        )
        predictiveBackRegistered = true
      } else if (!canGoBack && predictiveBackRegistered) {
        onBackInvokedDispatcher.unregisterOnBackInvokedCallback(callback)
        predictiveBackRegistered = false
      }
    } else {
      legacyBackCallback?.isEnabled = canGoBack
    }
  }

  private fun commitBack(expectedRevision: Long, source: String) {
    when (val outcome = authority.back(expectedRevision, "$source-${UUID.randomUUID()}")) {
      is PrototypeBackOutcome.Applied -> render(outcome.snapshot)
      is PrototypeBackOutcome.ExitRequested -> finishAfterTransition()
      is PrototypeBackOutcome.Stale -> render(outcome.snapshot)
    }
  }

  private fun previewBack(progress: Float) {
    if (!ValueAnimator.areAnimatorsEnabled()) return
    webView.evaluateJavascript(
      "window.routeProjection && window.routeProjection.previewBack(${progress.coerceIn(0f, 1f)});",
      null,
    )
  }

  private fun showNativeSheet() {
    val dialog = BottomSheetDialog(this)
    val content = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(24), dp(18), dp(24), dp(32))
      addView(TextView(context).apply {
        text = "Native sheet"
        textSize = 22f
        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
      })
      addView(RadioButton(context).apply {
        text = "Current route: ${currentSnapshot.activePath}"
        isChecked = true
      })
      addView(RadioButton(context).apply {
        text = "Disabled state sample"
        isEnabled = false
      })
    }
    dialog.setContentView(content)
    dialog.setOnDismissListener {
      webView.requestFocus()
      webView.evaluateJavascript("window.routeProjection && window.routeProjection.restoreFocus();", null)
    }
    dialog.show()
  }

  private fun toggleAppearance() {
    val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
      Configuration.UI_MODE_NIGHT_YES
    AppCompatDelegate.setDefaultNightMode(
      if (dark) AppCompatDelegate.MODE_NIGHT_NO else AppCompatDelegate.MODE_NIGHT_YES,
    )
  }

  private fun announce(message: String) {
    navigation.announceForAccessibility(message)
  }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  private inner class WebRouteBridge {
    @JavascriptInterface
    fun openPath(path: String, expectedRevision: Long, intentId: String) {
      runOnUiThread {
        authority.openPath(path, expectedRevision, intentId)?.let(::render)
      }
    }
  }

  companion object {
    const val EXTRA_PROTOTYPE_ROUTE = "prototype-route"
    private const val JS_BRIDGE_NAME = "NativeRouteBridge"
    private const val ID_HOME = 10_001
    private const val ID_ROUTES = 10_002
    private const val ID_PROFILES = 10_003
    private const val ID_ACTIVITY = 10_004
    private const val ID_SETTINGS = 10_005

    private val PROTOTYPE_HTML = """
      <!doctype html>
      <html lang="en">
      <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
      <style>
        :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 24px 18px 64px; background: Canvas; color: CanvasText; }
        main { max-width: 680px; margin: auto; }
        .card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 20px; padding: 20px; transition: transform 180ms ease, opacity 180ms ease; transform-origin: left center; }
        h1 { margin: 0 0 8px; font-size: 30px; }
        p { line-height: 1.5; }
        .facts { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; }
        .fact { border-radius: 999px; padding: 6px 10px; background: color-mix(in srgb, CanvasText 9%, transparent); }
        button, input { min-height: 48px; border-radius: 12px; font: inherit; }
        button { border: 0; padding: 0 16px; margin: 4px; background: #2f6fdc; color: white; }
        input { width: 100%; margin-top: 24px; padding: 0 12px; border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); background: Canvas; color: CanvasText; }
        @media (prefers-reduced-motion: reduce) { .card { transition: none; } }
      </style>
      <body>
        <main>
          <section class="card" id="route-card">
            <h1 id="route-heading" tabindex="-1">Home</h1>
            <p>This WebView is a route projection. Native chrome and Web content submit intents to one revisioned authority.</p>
            <div class="facts">
              <span class="fact" id="path">/status</span>
              <span class="fact" id="revision">revision 0</span>
              <span class="fact" id="back">root</span>
            </div>
            <button onclick="openRoute('/routes/streaming')">Open route child</button>
            <button onclick="openRoute('/traffic?tab=rules')">Deep-link Activity rules</button>
            <button onclick="openRoute('/settings/network')">Open Settings child</button>
            <input id="ime-probe" aria-label="Keyboard inset probe" placeholder="Focus to test IME insets">
          </section>
        </main>
      <script>
        let snapshot = { revision: 0, focusToken: 0 };
        let lastFocusToken = -1;
        function intentId() { return 'web-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
        function openRoute(path) { NativeRouteBridge.openPath(path, snapshot.revision, intentId()); }
        const imeProbe = document.getElementById('ime-probe');
        function revealImeProbe() {
          if (document.activeElement === imeProbe) {
            requestAnimationFrame(() => imeProbe.scrollIntoView({ block: 'center' }));
          }
        }
        imeProbe.addEventListener('focus', revealImeProbe);
        window.visualViewport?.addEventListener('resize', revealImeProbe);
        window.routeProjection = {
          apply(next) {
            snapshot = next;
            history.replaceState({ revision: next.revision }, '', '#' + next.activePath);
            document.getElementById('route-heading').textContent = next.title;
            document.getElementById('path').textContent = next.activePath;
            document.getElementById('revision').textContent = 'revision ' + next.revision;
            document.getElementById('back').textContent = next.canGoBack ? 'back available' : 'tab root';
            document.getElementById('route-card').style.transform = '';
            document.getElementById('route-card').style.opacity = '';
            if (next.focusToken !== lastFocusToken) {
              lastFocusToken = next.focusToken;
              requestAnimationFrame(() => document.getElementById('route-heading').focus({ preventScroll: true }));
            }
          },
          previewBack(progress) {
            const card = document.getElementById('route-card');
            card.style.transform = 'translateX(' + (progress * 18) + 'px) scale(' + (1 - progress * .025) + ')';
            card.style.opacity = String(1 - progress * .15);
          },
          restoreFocus() { document.getElementById('route-heading').focus({ preventScroll: true }); }
        };
      </script>
      </body></html>
    """.trimIndent()
  }
}

private enum class PrototypeTab(val menuId: Int, val rootPath: String) {
  HOME(10_001, "/status"),
  ROUTES(10_002, "/routes"),
  PROFILES(10_003, "/profiles"),
  ACTIVITY(10_004, "/traffic"),
  SETTINGS(10_005, "/settings");

  companion object {
    fun fromMenuId(menuId: Int): PrototypeTab? = entries.firstOrNull { it.menuId == menuId }

    fun fromPath(path: String): PrototypeTab? {
      val pathOnly = path.substringBefore('?')
      return when {
        pathOnly == "/status" || pathOnly.startsWith("/status/") -> HOME
        pathOnly == "/routes" || pathOnly.startsWith("/routes/") -> ROUTES
        pathOnly == "/profiles" || pathOnly.startsWith("/profiles/") -> PROFILES
        pathOnly == "/traffic" || pathOnly == "/events" -> ACTIVITY
        pathOnly == "/settings" || pathOnly.startsWith("/settings/") -> SETTINGS
        else -> null
      }
    }
  }
}

private data class PrototypeNavigationSnapshot(
  val revision: Long,
  val focusToken: Long,
  val selectedTab: PrototypeTab,
  val activePath: String,
  val canGoBack: Boolean,
) {
  val title: String
    get() = when (selectedTab) {
      PrototypeTab.HOME -> "Home"
      PrototypeTab.ROUTES -> "Routes"
      PrototypeTab.PROFILES -> "Profiles"
      PrototypeTab.ACTIVITY -> "Activity"
      PrototypeTab.SETTINGS -> "Settings"
    }

  fun toJson(): JSONObject = JSONObject().apply {
    put("revision", revision)
    put("focusToken", focusToken)
    put("selectedTab", selectedTab.name.lowercase())
    put("activePath", activePath)
    put("canGoBack", canGoBack)
    put("title", title)
  }
}

private sealed interface PrototypeBackOutcome {
  data class Applied(val snapshot: PrototypeNavigationSnapshot) : PrototypeBackOutcome
  data class Stale(val snapshot: PrototypeNavigationSnapshot) : PrototypeBackOutcome
  data class ExitRequested(val snapshot: PrototypeNavigationSnapshot) : PrototypeBackOutcome
}

private class PrototypeNavigationAuthority {
  private var revision = 0L
  private var focusToken = 0L
  private var selectedTab = PrototypeTab.HOME
  private val stacks = PrototypeTab.entries.associateWith { mutableListOf(it.rootPath) }.toMutableMap()
  private val retiredIntentIds = LinkedHashSet<String>()

  fun snapshot(): PrototypeNavigationSnapshot {
    val activeStack = stacks.getValue(selectedTab)
    return PrototypeNavigationSnapshot(
      revision = revision,
      focusToken = focusToken,
      selectedTab = selectedTab,
      activePath = activeStack.last(),
      canGoBack = activeStack.size > 1,
    )
  }

  fun selectTab(tab: PrototypeTab, expectedRevision: Long, intentId: String): PrototypeNavigationSnapshot? {
    if (!admit(expectedRevision, intentId)) return snapshot()
    selectedTab = tab
    commit(intentId)
    return snapshot()
  }

  fun openPath(path: String, expectedRevision: Long, intentId: String): PrototypeNavigationSnapshot? {
    val tab = PrototypeTab.fromPath(path) ?: return snapshot()
    if (!admit(expectedRevision, intentId)) return snapshot()
    selectedTab = tab
    val stack = stacks.getValue(tab)
    if (path == tab.rootPath) {
      stack.subList(1, stack.size).clear()
    } else if (stack.last() != path) {
      stack.add(path)
    }
    commit(intentId)
    return snapshot()
  }

  fun back(expectedRevision: Long, intentId: String): PrototypeBackOutcome {
    if (!admit(expectedRevision, intentId)) return PrototypeBackOutcome.Stale(snapshot())
    val stack = stacks.getValue(selectedTab)
    if (stack.size == 1) return PrototypeBackOutcome.ExitRequested(snapshot())
    stack.removeLast()
    commit(intentId)
    return PrototypeBackOutcome.Applied(snapshot())
  }

  private fun admit(expectedRevision: Long, intentId: String): Boolean =
    expectedRevision == revision && intentId !in retiredIntentIds

  private fun commit(intentId: String) {
    revision += 1
    focusToken += 1
    retiredIntentIds += intentId
    while (retiredIntentIds.size > 128) retiredIntentIds.remove(retiredIntentIds.first())
  }
}
