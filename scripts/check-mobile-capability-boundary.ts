import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const sourceExtensions = new Set([
  ".java",
  ".js",
  ".kt",
  ".kts",
  ".m",
  ".mm",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);
const scanRoots = ["apps/mobile/src-tauri", "apps/web/src"] as const;
const generatedSourceDirectories = new Set([
  "apps/mobile/src-tauri/gen/android/app/src/main/java/com/asuka109/mish/generated",
]);

const retiredPersistentShellArtifacts = [
  "apps/mobile/src-tauri/gen/android/app/src/debug/AndroidManifest.xml",
  "apps/mobile/src-tauri/gen/android/app/src/debug/java/com/asuka109/mish/ShellPrototypeActivity.kt",
  "crates/mobile-shell",
  "docs/architecture/mobile-native-shell-entry.md",
  "docs/quality/mobile-native-shell-prototype.md",
  "prototypes/mobile-shell",
  "scripts/check-mobile-shell-boundary.test.ts",
  "scripts/check-mobile-shell-boundary.ts",
] as const;

export interface CapabilityBoundarySource {
  path: string;
  text: string;
}

export interface CapabilityBoundaryViolation {
  rule: string;
  path: string;
}

export function isGeneratedSourceDirectory(path: string) {
  return generatedSourceDirectories.has(path);
}

export function parseTomlStringArray(source: string, key: string): string[] {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(
    new RegExp(String.raw`^\s*${escapedKey}\s*=\s*\[([\s\S]*?)^\s*\]`, "mu"),
  );
  invariant(match, `Missing TOML string array: ${key}`);

  const values: string[] = [];
  const residue = match[1].replace(/"(?:[^"\\]|\\.)*"/gu, (value) => {
    values.push(JSON.parse(value) as string);
    return "";
  });
  invariant(/^[\s,]*$/u.test(residue), `Invalid TOML string array: ${key}`);
  return values;
}

export function isExactStringSet(actual: readonly string[], expected: readonly string[]) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

interface CapabilityBoundaryRule {
  id: string;
  applies(path: string): boolean;
  pattern: RegExp;
}

const androidSource = (path: string) => /\.(?:java|kt|kts)$/u.test(path);
const appleSource = (path: string) => /\.(?:m|mm|swift)$/u.test(path);
const webSource = (path: string) => /apps\/web\/src\/.*\.(?:js|ts|tsx)$/u.test(path);
const mobileRust = (path: string) => /apps\/mobile\/src-tauri\/.*\.rs$/u.test(path);

const bareNativeUiAction = String.raw`(?:(?:select|switch|change|open|close|show|hide|trigger|perform|navigate|go|set)[_:-]?(?:tab|drawer|sheet|back|focus|haptic)|(?:navigate|open)[_:-]?route)`;
const nativeUiToken = String.raw`(?:shell|native[_:-]?(?:tab|drawer|sheet|back|focus|haptic|route)|${bareNativeUiAction})`;
const boundedCommandName = String.raw`[^"'\x60\r\n]{0,80}${nativeUiToken}`;

const rules: readonly CapabilityBoundaryRule[] = [
  {
    id: "android-javascript-interface",
    applies: androidSource,
    pattern: /addJavascriptInterface|@JavascriptInterface|\bJavascriptInterface\b/u,
  },
  {
    id: "android-web-message-listener",
    applies: androidSource,
    pattern:
      /addWebMessageListener|\bWebMessageListener\b|\bWebMessagePort\b|\bonPostMessage\s*\(/u,
  },
  {
    id: "apple-script-message-handler",
    applies: appleSource,
    pattern:
      /WKScriptMessageHandler|WKScriptMessage|userContentController\s*\.\s*add\s*\(|addScriptMessageHandler/u,
  },
  {
    id: "apple-custom-scheme-handler",
    applies: appleSource,
    pattern: /WKURLSchemeHandler|setURLSchemeHandler/u,
  },
  {
    id: "web-platform-message-handler",
    applies: webSource,
    pattern:
      /window\s*\.\s*webkit\s*\.\s*messageHandlers|\bNativeRouteBridge\b|\bWebRouteBridge\b/u,
  },
  {
    id: "web-facing-native-ui-command",
    applies: webSource,
    pattern: new RegExp(String.raw`\binvoke(?:<[^>]+>)?\s*\(\s*["'\x60]${boundedCommandName}`, "u"),
  },
  {
    id: "web-emitted-native-ui-event",
    applies: webSource,
    pattern: new RegExp(String.raw`\b(?:emit|emitTo)\s*\(\s*["'\x60]${boundedCommandName}`, "u"),
  },
  {
    id: "mobile-tauri-native-ui-command",
    applies: mobileRust,
    pattern: new RegExp(
      String.raw`#\s*\[\s*tauri::command\s*\][\s\S]{0,240}?\bfn\s+\w{0,80}${nativeUiToken}`,
      "u",
    ),
  },
  {
    id: "mobile-rust-listens-for-web-ui-event",
    applies: mobileRust,
    pattern: new RegExp(
      String.raw`\b(?:listen|listen_any|listen_global)\s*\(\s*["'\x60]${boundedCommandName}`,
      "u",
    ),
  },
  {
    id: "custom-url-command-channel",
    applies: () => true,
    pattern:
      /(?:mish[-_]?shell|mish[-_]?native|native[-_]?command|shell[-_]?command):(?:\/\/)?|(?:mish|native|shell):\/\/(?:action|command|shell|native|select|switch|change|open|close|show|hide|trigger|perform|navigate|go|set)(?:[/?#:_-]|$)|shouldOverrideUrlLoading[\s\S]{0,240}(?:command|shell|native)|decidePolicyFor[\s\S]{0,240}(?:command|shell|native)/iu,
  },
];

export function findMobileCapabilityBoundaryViolations(
  sources: readonly CapabilityBoundarySource[],
): CapabilityBoundaryViolation[] {
  const violations: CapabilityBoundaryViolation[] = [];
  for (const source of sources) {
    for (const rule of rules) {
      if (rule.applies(source.path) && rule.pattern.test(source.text)) {
        violations.push({ rule: rule.id, path: source.path });
      }
      rule.pattern.lastIndex = 0;
    }
  }
  return violations;
}

function collectSources(relativeDirectory: string): CapabilityBoundarySource[] {
  const absoluteDirectory = resolve(root, relativeDirectory);
  const sources: CapabilityBoundarySource[] = [];

  function visit(directory: string) {
    const relativePath = directory.slice(root.length + 1);
    if (isGeneratedSourceDirectory(relativePath)) return;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "build" || entry.name === "target") continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
        sources.push({
          path: absolutePath.slice(root.length + 1),
          text: readFileSync(absolutePath, "utf8"),
        });
      }
    }
  }

  visit(absoluteDirectory);
  return sources;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sorted(values: readonly string[]) {
  return [...values].sort();
}

export function checkRepositoryMobileCapabilityBoundary() {
  const sources = scanRoots.flatMap(collectSources);
  const violations = findMobileCapabilityBoundaryViolations(sources);
  invariant(
    violations.length === 0,
    `Mobile capability boundary violations:\n${violations
      .map(({ path, rule }) => `- ${path}: ${rule}`)
      .join("\n")}`,
  );

  const survivingArtifacts = retiredPersistentShellArtifacts.filter((path) =>
    existsSync(resolve(root, path)),
  );
  invariant(
    survivingArtifacts.length === 0,
    `Retired native persistent-shell artifacts remain:\n${survivingArtifacts
      .map((path) => `- ${path}`)
      .join("\n")}`,
  );

  const mobileShell = readFileSync(
    resolve(root, "apps/web/src/components/mobile-shell.tsx"),
    "utf8",
  );
  const mobileApp = readFileSync(resolve(root, "apps/web/src/mobile-app.tsx"), "utf8");
  for (const required of [
    "export function MobileShell",
    "useLocation()",
    "<NavLink",
    "mobileBackTarget",
    "bottomNavigation",
  ]) {
    invariant(
      mobileShell.includes(required),
      `The Web mobile navigation owner is missing ${required}`,
    );
  }
  invariant(
    mobileApp.includes("shell={<MobileShell"),
    "The installed mobile product no longer selects the Web MobileShell",
  );

  const mobileCapability = JSON.parse(
    readFileSync(resolve(root, "apps/mobile/src-tauri/capabilities/mobile.json"), "utf8"),
  ) as { permissions: string[] };
  invariant(
    isExactStringSet(mobileCapability.permissions, [
      "allow-mobile-fixture-bootstrap",
      "core:event:allow-listen",
      "core:event:allow-unlisten",
      "mish-vpn:default",
    ]),
    "The mobile WebView capability set changed; review it as a typed least-privilege boundary",
  );

  const vpnDefaultPermissions = parseTomlStringArray(
    readFileSync(
      resolve(root, "apps/mobile/src-tauri/plugins/mish-vpn/permissions/default.toml"),
      "utf8",
    ),
    "permissions",
  );
  invariant(
    isExactStringSet(vpnDefaultPermissions, [
      "allow-get-core-provenance",
      "allow-get-route-snapshot",
      "allow-get-snapshot",
      "allow-get-traffic-snapshot",
      "allow-close-traffic-connection",
      "allow-register-listener",
      "allow-registerListener",
      "allow-remove-listener",
      "allow-removeListener",
      "allow-request-notification-permission",
      "allow-request-vpn-consent",
      "allow-start",
      "allow-stop",
      "allow-cancel-lifecycle-operation",
      "allow-validate-config",
      "allow-load-config",
      "allow-select-route-child",
      "allow-cancel-route-selection",
      "allow-cancel-config-load",
    ]),
    "The Mish VPN default permission bundle changed; review every command as a typed least-privilege capability",
  );

  const settingsCapability = JSON.parse(
    readFileSync(
      resolve(root, "apps/mobile/src-tauri/capabilities/mobile-settings-android.json"),
      "utf8",
    ),
  ) as { permissions: string[] };
  invariant(
    isExactStringSet(settingsCapability.permissions, [
      "allow-mobile-settings-get-snapshot",
      "allow-mobile-settings-set-appearance",
      "allow-mobile-settings-set-language",
    ]),
    "The Android Settings capability set changed; review it as a typed least-privilege boundary",
  );

  console.log(
    `Mobile capability boundary valid across ${sources.length} source files: the Web MobileShell owns product navigation and Native exposes only reviewed typed platform effects.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkRepositoryMobileCapabilityBoundary();
}
