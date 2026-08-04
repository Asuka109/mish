import assert from "node:assert/strict";
import test from "node:test";
import {
  checkRepositoryMobileShellBoundary,
  findMobileShellBoundaryViolations,
  findRuntimeCargoDependencies,
  type BoundarySource,
} from "./check-mobile-shell-boundary.ts";

const forbiddenCases: Array<{
  expectedRule: string;
  source: BoundarySource;
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
      text: 'WebViewCompat.addWebMessageListener(webView, "shell", origins, listener)',
    },
  },
  {
    expectedRule: "apple-script-message-handler",
    source: {
      path: "prototypes/mobile-shell/ios/Bridge.swift",
      text: "final class Bridge: NSObject, WKScriptMessageHandler {}",
    },
  },
  {
    expectedRule: "apple-custom-scheme-handler",
    source: {
      path: "prototypes/mobile-shell/ios/Bridge.swift",
      text: 'configuration.setURLSchemeHandler(handler, forURLScheme: "mish")',
    },
  },
  {
    expectedRule: "web-platform-message-handler",
    source: {
      path: "apps/web/src/platform/mobile-shell.ts",
      text: 'window.webkit.messageHandlers.shell.postMessage({ tab: "settings" });',
    },
  },
  {
    expectedRule: "web-facing-tauri-shell-command",
    source: {
      path: "apps/web/src/platform/mobile-shell.ts",
      text: 'await invoke("mobile_shell_select_tab", { tab: "settings" });',
    },
  },
  {
    expectedRule: "web-facing-tauri-shell-command",
    source: {
      path: "apps/web/src/platform/mobile-shell.ts",
      text: 'await invoke("select_tab", { tab: "settings" });',
    },
  },
  {
    expectedRule: "web-emitted-native-ui-event",
    source: {
      path: "apps/web/src/platform/mobile-shell.ts",
      text: 'await emit("mish:native-sheet-open", { sheet: "permission" });',
    },
  },
  {
    expectedRule: "web-emitted-native-ui-event",
    source: {
      path: "apps/web/src/platform/mobile-shell.ts",
      text: 'await emit("open_permission", { kind: "vpn" });',
    },
  },
  {
    expectedRule: "mobile-tauri-shell-command",
    source: {
      path: "apps/mobile/src-tauri/src/lib.rs",
      text: "#[tauri::command]\nfn mobile_shell_select_tab(tab: String) {}",
    },
  },
  {
    expectedRule: "mobile-tauri-shell-command",
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
    expectedRule: "web-facing-tauri-shell-command",
    source: {
      path: "apps/web/src/platform/mobile-shell.ts",
      text: 'await invoke("select_native_tab", { tab: "settings" });',
    },
  },
  {
    expectedRule: "custom-url-command-channel",
    source: {
      path: "apps/mobile/src-tauri/gen/android/app/src/main/java/Bridge.kt",
      text: 'webView.loadUrl("mish-shell-command://select?tab=settings")',
    },
  },
  {
    expectedRule: "custom-url-command-channel",
    source: {
      path: "apps/mobile/src-tauri/gen/android/app/src/main/java/Bridge.kt",
      text: 'webView.loadUrl("mish://select?tab=settings")',
    },
  },
];

for (const { expectedRule, source } of forbiddenCases) {
  test(`rejects ${expectedRule}`, () => {
    const violations = findMobileShellBoundaryViolations([source]);
    assert.ok(violations.some(({ rule }) => rule === expectedRule));
  });
}

test("accepts a strictly one-way platform-neutral entry seam", () => {
  const sources: BoundarySource[] = [
    {
      path: "apps/mobile/src-tauri/gen/android/app/src/main/java/ShellHost.kt",
      text: "rustAuthority.selectAndroidDestination(ShellDestination.Settings)",
    },
    {
      path: "prototypes/mobile-shell/ios/ShellHost.swift",
      text: "rustAuthority.openPlatformDeepLink(validatedEntry)",
    },
    {
      path: "apps/web/src/platform/shell-entry.ts",
      text: "navigate(validatedDirective.webEntryPath, { replace: true });",
    },
  ];

  assert.deepEqual(findMobileShellBoundaryViolations(sources), []);
});

test("finds normal and target-specific runtime Cargo dependencies", () => {
  assert.deepEqual(
    findRuntimeCargoDependencies({
      packages: [
        {
          name: "mish-mobile-shell",
          dependencies: [
            { kind: "dev", name: "serde", target: null },
            { kind: null, name: "runtime", target: null },
            { kind: "build", name: "builder", target: null },
            {
              kind: null,
              name: "android-runtime",
              target: 'cfg(target_os = "android")',
            },
          ],
        },
      ],
    }),
    ["mish-mobile-shell:runtime", 'mish-mobile-shell:android-runtime@cfg(target_os = "android")'],
  );
});

test("the checked-in repository keeps the native shell production-disabled", () => {
  assert.doesNotThrow(checkRepositoryMobileShellBoundary);
});
