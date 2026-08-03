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
 * Shared Rust owns only the outer-shell selection. Native chrome emits one-way
 * entry directives into the WebView, while Web content owns its routes, history,
 * back, and focus without any API for invoking native capabilities.
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
      commitWebBack()
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
        override fun onBackStarted(backEvent: BackEvent) {
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
          commitWebBack()
        }
      }
      predictiveBackCallback = callback
      onBackInvokedDispatcher.registerOnBackInvokedCallback(
        OnBackInvokedDispatcher.PRIORITY_DEFAULT,
        callback,
      )
      predictiveBackRegistered = true
    } else {
      val callback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          commitWebBack()
        }
      }
      legacyBackCallback = callback
      onBackPressedDispatcher.addCallback(this, callback)
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun configureWebView() {
    webView.settings.javaScriptEnabled = true
    webView.settings.domStorageEnabled = false
    webView.webViewClient = object : WebViewClient() {
      override fun onPageFinished(view: WebView, url: String) {
        render(currentSnapshot)
      }

    }
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
    val motion = ValueAnimator.areAnimatorsEnabled()
    toolbar.subtitle =
      "revision ${snapshot.revision} · ${if (motion) "motion" else "reduced motion"}"
    val encoded = JSONObject.quote(snapshot.toJson().toString())
    webView.evaluateJavascript(
      "window.routeProjection && window.routeProjection.apply(JSON.parse($encoded));",
      null,
    )
  }

  private fun commitWebBack() {
    webView.evaluateJavascript(
      "document.documentElement.dataset.webCanGoBack === 'true';",
    ) { canGoBack ->
      if (canGoBack == "true") {
        webView.evaluateJavascript("window.routeProjection.back();", null)
      } else {
        finishAfterTransition()
      }
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
        text = "Shell entry: ${currentSnapshot.webEntryPath}"
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

  companion object {
    const val EXTRA_PROTOTYPE_ROUTE = "prototype-route"
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
            <p>Native chrome selects only the outer shell. This WebView owns its internal routes, history, back, and focus without a Native bridge.</p>
            <div class="facts">
              <span class="fact" id="path">/status</span>
              <span class="fact" id="revision">shell revision 0</span>
              <span class="fact" id="back">Web root</span>
            </div>
            <button onclick="openInternalChild()">Open internal child</button>
            <button onclick="openInternalDetail()">Open nested Web detail</button>
            <input id="ime-probe" aria-label="Keyboard inset probe" placeholder="Focus to test IME insets">
          </section>
        </main>
      <script>
        let shellSnapshot = { revision: 0, webEntryPath: '/status', title: 'Home' };
        let webStack = ['/status'];
        function normalizedRoot() { return shellSnapshot.webEntryPath.split('?')[0].split('/').slice(0, 2).join('/'); }
        function openInternalChild() { openInternalRoute(normalizedRoot() + '/details'); }
        function openInternalDetail() { openInternalRoute(normalizedRoot() + '/details/advanced'); }
        function openInternalRoute(path) {
          webStack.push(path);
          const depth = webStack.length - 1;
          history.pushState({ webDepth: depth }, '', '#' + path);
          renderWebRoute(path, depth);
        }
        function renderWebRoute(path, depth) {
          document.getElementById('route-heading').textContent = shellSnapshot.title;
          document.getElementById('path').textContent = path;
          document.getElementById('revision').textContent = 'shell revision ' + shellSnapshot.revision;
          document.getElementById('back').textContent = depth > 0 ? 'Web back available' : 'Web root';
          document.documentElement.dataset.webCanGoBack = depth > 0 ? 'true' : 'false';
          document.getElementById('route-card').style.transform = '';
          document.getElementById('route-card').style.opacity = '';
          requestAnimationFrame(() => document.getElementById('route-heading').focus({ preventScroll: true }));
        }
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
            shellSnapshot = next;
            webStack = [next.webEntryPath];
            history.replaceState({ webDepth: 0 }, '', '#' + next.webEntryPath);
            renderWebRoute(next.webEntryPath, 0);
          },
          previewBack(progress) {
            const card = document.getElementById('route-card');
            card.style.transform = 'translateX(' + (progress * 18) + 'px) scale(' + (1 - progress * .025) + ')';
            card.style.opacity = String(1 - progress * .15);
          },
          back() {
            if (webStack.length <= 1) return;
            webStack.pop();
            const path = webStack[webStack.length - 1];
            const depth = webStack.length - 1;
            history.replaceState({ webDepth: depth }, '', '#' + path);
            renderWebRoute(path, depth);
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
  val selectedTab: PrototypeTab,
  val webEntryPath: String,
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
    put("selectedTab", selectedTab.name.lowercase())
    put("webEntryPath", webEntryPath)
    put("title", title)
  }
}

private class PrototypeNavigationAuthority {
  private var revision = 0L
  private var selectedTab = PrototypeTab.HOME
  private var webEntryPath = PrototypeTab.HOME.rootPath
  private val retiredIntentIds = LinkedHashSet<String>()

  fun snapshot(): PrototypeNavigationSnapshot {
    return PrototypeNavigationSnapshot(
      revision = revision,
      selectedTab = selectedTab,
      webEntryPath = webEntryPath,
    )
  }

  fun selectTab(tab: PrototypeTab, expectedRevision: Long, intentId: String): PrototypeNavigationSnapshot? {
    if (!admit(expectedRevision, intentId)) return snapshot()
    selectedTab = tab
    webEntryPath = tab.rootPath
    commit(intentId)
    return snapshot()
  }

  fun openPath(path: String, expectedRevision: Long, intentId: String): PrototypeNavigationSnapshot? {
    val tab = PrototypeTab.fromPath(path) ?: return snapshot()
    if (!admit(expectedRevision, intentId)) return snapshot()
    selectedTab = tab
    webEntryPath = path
    commit(intentId)
    return snapshot()
  }

  private fun admit(expectedRevision: Long, intentId: String): Boolean =
    expectedRevision == revision && intentId !in retiredIntentIds

  private fun commit(intentId: String) {
    revision += 1
    retiredIntentIds += intentId
    while (retiredIntentIds.size > 128) retiredIntentIds.remove(retiredIntentIds.first())
  }
}
