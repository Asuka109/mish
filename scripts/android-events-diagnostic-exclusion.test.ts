import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFile(path.join(root, file), "utf8");

test("Android Events and fixed diagnostic remain outside desktop authority", async () => {
  const [desktopBridge, desktopRuntime, mobileRust, kotlin, webClient] = await Promise.all([
    read("crates/desktop-bridge/src/lib.rs"),
    read("crates/runtime/src/lib.rs"),
    read("apps/mobile/src-tauri/plugins/mish-vpn/src/mobile_events.rs"),
    read(
      "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/java/com/asuka109/mish/vpn/MishFixedDiagnostic.kt",
    ),
    read("apps/web/src/platform/mobile-events-client.ts"),
  ]);

  for (const desktop of [desktopBridge, desktopRuntime]) {
    assert.doesNotMatch(desktop, /start_diagnostic|get_diagnostic_snapshot|generate_204/u);
  }
  assert.match(mobileRust, /FIXED_DIAGNOSTIC_TARGET/u);
  assert.match(kotlin, /https:\/\/www\.gstatic\.com\/generate_204/u);
  assert.doesNotMatch(kotlin, /(?:val|var)\s+(?:history|notifications?)\b/i);
  assert.doesNotMatch(webClient, /WebSocket|127\.0\.0\.1|localhost/u);
});

test("fixed diagnostic accepts identities but no endpoint or timeout selection", async () => {
  const [rust, kotlin, client] = await Promise.all([
    read("apps/mobile/src-tauri/plugins/mish-vpn/src/mobile_events.rs"),
    read(
      "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/java/com/asuka109/mish/vpn/MishFixedDiagnostic.kt",
    ),
    read("apps/web/src/platform/mobile-events-client.ts"),
  ]);
  const request = rust.match(/pub struct MobileDiagnosticCommandRequest \{[^}]+\}/u)?.[0];
  assert.ok(request);
  assert.doesNotMatch(request, /pub\s+(target|timeout_millis)\s*:/u);
  assert.doesNotMatch(kotlin, /var\s+(target|url|timeout)/iu);
  assert.doesNotMatch(client, /start_diagnostic[^]*target|start_diagnostic[^]*timeoutMillis/u);
});
