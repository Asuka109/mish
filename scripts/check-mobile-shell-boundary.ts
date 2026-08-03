import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function source(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const android = source(
  "apps/mobile/src-tauri/gen/android/app/src/debug/java/com/asuka109/mish/ShellPrototypeActivity.kt",
);
const apple = source(
  "prototypes/mobile-shell/ios/MishShellPrototype.swiftpm/Sources/MishShellPrototypeApp.swift",
);
const rust = source("prototypes/mobile-shell/navigation-authority/src/lib.rs");

for (const [label, sourceText, forbidden] of [
  [
    "Android",
    android,
    [/addJavascriptInterface/u, /@JavascriptInterface/u, /NativeRouteBridge/u, /WebRouteBridge/u],
  ],
  [
    "Apple",
    apple,
    [/WKScriptMessageHandler/u, /WKUserContentController/u, /userContentController\s*\.\s*add/u],
  ],
  [
    "Shared Rust shell authority",
    rust,
    [
      /ReactLink/u,
      /PlatformBack/u,
      /tab_stacks/u,
      /focus_token/u,
      /can_go_back/u,
      /NavigationAction::Back/u,
    ],
  ],
] as const) {
  for (const pattern of forbidden) {
    invariant(!pattern.test(sourceText), `${label} reintroduced forbidden boundary: ${pattern}`);
  }
}

for (const required of [
  "This WebView owns its internal routes, history, back, and focus",
  "document.documentElement.dataset.webCanGoBack",
  "window.routeProjection.back();",
  "webEntryPath",
]) {
  invariant(android.includes(required), `Android shell is missing boundary evidence: ${required}`);
}

for (const required of [
  "React Router owns all content",
  "There is intentionally no Web-originated native command API",
  "one Tauri-owned",
]) {
  invariant(apple.includes(required), `Apple shell is missing boundary evidence: ${required}`);
}

for (const required of [
  "ShellIntentSource",
  "PlatformDeepLink",
  "RejectedSource",
  "web_entry_path",
]) {
  invariant(
    rust.includes(required),
    `Shared Rust shell is missing closed-contract evidence: ${required}`,
  );
}

console.log(
  "Mobile shell boundary valid: Native -> Shared Rust -> Web entry only; Web routes, history, back, and focus remain Web-owned.",
);
