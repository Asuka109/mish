import assert from "node:assert/strict";
import test from "node:test";
import "./android-events-diagnostic-exclusion.test.ts";
import {
  checkRepositoryMobileCapabilityBoundary,
  findMobileCapabilityBoundaryViolations,
  isExactStringSet,
  isGeneratedSourceDirectory,
  parseTomlStringArray,
  type CapabilityBoundarySource,
} from "./check-mobile-capability-boundary.ts";

const forbiddenCases: Array<{
  expectedRule: string;
  source: CapabilityBoundarySource;
}> = [
  {
    expectedRule: "android-javascript-interface",
    source: {
      path: "apps/mobile/src-tauri/gen/android/app/src/main/java/Bridge.kt",
      text: 'webView.addJavascriptInterface(Bridge(), "Native")',
    },
  },
  {
    expectedRule: "android-web-message-listener",
    source: {
      path: "apps/mobile/src-tauri/gen/android/app/src/main/java/Bridge.kt",
      text: 'WebViewCompat.addWebMessageListener(webView, "nativeUi", origins, listener)',
    },
  },
  {
    expectedRule: "apple-script-message-handler",
    source: {
      path: "apps/mobile/src-tauri/gen/apple/Sources/Bridge.swift",
      text: "final class Bridge: NSObject, WKScriptMessageHandler {}",
    },
  },
  {
    expectedRule: "apple-custom-scheme-handler",
    source: {
      path: "apps/mobile/src-tauri/gen/apple/Sources/Bridge.swift",
      text: 'configuration.setURLSchemeHandler(handler, forURLScheme: "mish")',
    },
  },
  {
    expectedRule: "web-platform-message-handler",
    source: {
      path: "apps/web/src/platform/mobile-ui.ts",
      text: 'window.webkit.messageHandlers.nativeUi.postMessage({ tab: "settings" });',
    },
  },
  {
    expectedRule: "web-facing-native-ui-command",
    source: {
      path: "apps/web/src/platform/mobile-ui.ts",
      text: 'await invoke("select_native_tab", { tab: "settings" });',
    },
  },
  {
    expectedRule: "web-emitted-native-ui-event",
    source: {
      path: "apps/web/src/platform/mobile-ui.ts",
      text: 'await emit("mish:native-sheet-open", { sheet: "permission" });',
    },
  },
  {
    expectedRule: "mobile-tauri-native-ui-command",
    source: {
      path: "apps/mobile/src-tauri/src/lib.rs",
      text: "#[tauri::command]\nfn select_tab(tab: String) {}",
    },
  },
  {
    expectedRule: "mobile-rust-listens-for-web-ui-event",
    source: {
      path: "apps/mobile/src-tauri/src/lib.rs",
      text: 'app.listen_global("mish:shell-select", |_event| {});',
    },
  },
  {
    expectedRule: "custom-url-command-channel",
    source: {
      path: "apps/mobile/src-tauri/gen/android/app/src/main/java/Bridge.kt",
      text: 'webView.loadUrl("mish-shell-command://select?tab=settings")',
    },
  },
];

for (const { expectedRule, source } of forbiddenCases) {
  test(`rejects ${expectedRule}`, () => {
    const violations = findMobileCapabilityBoundaryViolations([source]);
    assert.ok(violations.some(({ rule }) => rule === expectedRule));
  });
}

test("accepts reviewed typed platform capabilities", () => {
  const sources: CapabilityBoundarySource[] = [
    {
      path: "apps/web/src/platform/mobile-vpn-client.ts",
      text: 'invoke("plugin:mish-vpn|request_vpn_consent", { request: { operationId } });',
    },
    {
      path: "apps/web/src/platform/mobile-events-client.ts",
      text: 'invoke("plugin:mish-vpn|start_diagnostic", { request: { operationId } });',
    },
    {
      path: "apps/web/src/platform/mobile-settings-client.ts",
      text: 'invoke("mobile_settings_set_language", { request });',
    },
    {
      path: "apps/mobile/src-tauri/plugins/mish-vpn/src/lib.rs",
      text: "#[tauri::command]\nasync fn request_vpn_consent(request: MobileVpnCommandRequest) {}",
    },
  ];

  assert.deepEqual(findMobileCapabilityBoundaryViolations(sources), []);
});

test("rejects additions to a named default permission bundle", () => {
  const expected = ["allow-get-core-provenance", "allow-get-snapshot", "allow-start", "allow-stop"];
  const actual = parseTomlStringArray(
    'permissions = [\n  "allow-get-core-provenance",\n  "allow-get-snapshot",\n  "allow-start",\n  "allow-stop",\n]',
    "permissions",
  );
  assert.equal(isExactStringSet(actual, expected), true);
  assert.equal(isExactStringSet([...actual, "allow-select-native-tab"], expected), false);
});

test("repository scan excludes only Tauri's ignored Android runtime sources", () => {
  assert.equal(
    isGeneratedSourceDirectory(
      "apps/mobile/src-tauri/gen/android/app/src/main/java/com/asuka109/mish/generated",
    ),
    true,
  );
  assert.equal(
    isGeneratedSourceDirectory(
      "apps/mobile/src-tauri/gen/android/app/src/main/java/com/asuka109/mish",
    ),
    false,
  );
  assert.equal(isGeneratedSourceDirectory("apps/mobile/src-tauri/src"), false);
});

test("the checked-in repository keeps one Web navigation owner and bounded capabilities", () => {
  assert.doesNotThrow(checkRepositoryMobileCapabilityBoundary);
});
