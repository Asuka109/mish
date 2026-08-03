import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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
const scanRoots = [
  "apps/mobile/src-tauri",
  "apps/web/src",
  "crates/mobile-shell",
  "prototypes/mobile-shell/ios",
] as const;

export interface BoundarySource {
  path: string;
  text: string;
}

export interface BoundaryViolation {
  rule: string;
  path: string;
}

interface CargoMetadata {
  packages: Array<{
    dependencies: Array<{
      kind: string | null;
      name: string;
      target: string | null;
    }>;
    name: string;
  }>;
}

interface BoundaryRule {
  id: string;
  applies(path: string): boolean;
  pattern: RegExp;
}

const androidSource = (path: string) => /\.(?:java|kt|kts)$/u.test(path);
const appleSource = (path: string) => /\.(?:m|mm|swift)$/u.test(path);
const webSource = (path: string) => /apps\/web\/src\/.*\.(?:js|ts|tsx)$/u.test(path);
const mobileRust = (path: string) => /apps\/mobile\/src-tauri\/.*\.rs$/u.test(path);

const bareNativeUiAction = String.raw`(?:(?:select|switch|change|open|close|show|hide|request|trigger|perform|navigate|go|set)[_:-]?(?:tab|drawer|sheet|back|focus|haptic|permission)|(?:navigate|open)[_:-]?route)`;
const shellUiToken = String.raw`(?:shell|native[_:-]?(?:tab|drawer|sheet|back|focus|haptic|permission|route)|${bareNativeUiAction})`;
const boundedCommandName = String.raw`[^"'\x60\r\n]{0,80}${shellUiToken}`;

const rules: readonly BoundaryRule[] = [
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
    id: "web-facing-tauri-shell-command",
    applies: webSource,
    pattern: new RegExp(String.raw`\binvoke(?:<[^>]+>)?\s*\(\s*["'\x60]${boundedCommandName}`, "u"),
  },
  {
    id: "web-emitted-native-ui-event",
    applies: webSource,
    pattern: new RegExp(String.raw`\b(?:emit|emitTo)\s*\(\s*["'\x60]${boundedCommandName}`, "u"),
  },
  {
    id: "mobile-tauri-shell-command",
    applies: mobileRust,
    pattern: new RegExp(
      String.raw`#\s*\[\s*tauri::command\s*\][\s\S]{0,240}?\bfn\s+\w{0,80}${shellUiToken}`,
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
      /(?:mish[-_]?shell|mish[-_]?native|native[-_]?command|shell[-_]?command):(?:\/\/)?|(?:mish|native|shell):\/\/(?:action|command|shell|native|select|switch|change|open|close|show|hide|request|trigger|perform|navigate|go|set)(?:[/?#:_-]|$)|shouldOverrideUrlLoading[\s\S]{0,240}(?:command|shell|native)|decidePolicyFor[\s\S]{0,240}(?:command|shell|native)/iu,
  },
];

export function findMobileShellBoundaryViolations(
  sources: readonly BoundarySource[],
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
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

export function findRuntimeCargoDependencies(
  metadata: CargoMetadata,
  packageName = "mish-mobile-shell",
): string[] {
  return metadata.packages
    .filter((cargoPackage) => cargoPackage.name === packageName)
    .flatMap((cargoPackage) =>
      cargoPackage.dependencies
        .filter((dependency) => dependency.kind === null)
        .map((dependency) =>
          dependency.target
            ? `${cargoPackage.name}:${dependency.name}@${dependency.target}`
            : `${cargoPackage.name}:${dependency.name}`,
        ),
    );
}

function collectSources(relativeDirectory: string): BoundarySource[] {
  const absoluteDirectory = resolve(root, relativeDirectory);
  const sources: BoundarySource[] = [];

  function visit(directory: string) {
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

export function checkRepositoryMobileShellBoundary() {
  const sources = scanRoots.flatMap(collectSources);
  const violations = findMobileShellBoundaryViolations(sources);
  invariant(
    violations.length === 0,
    `Mobile shell boundary violations:\n${violations
      .map(({ path, rule }) => `- ${path}: ${rule}`)
      .join("\n")}`,
  );

  const rust = readFileSync(resolve(root, "crates/mobile-shell/src/lib.rs"), "utf8");
  const mobileManifest = readFileSync(resolve(root, "apps/mobile/src-tauri/Cargo.toml"), "utf8");
  const mobileHost = readFileSync(resolve(root, "apps/mobile/src-tauri/src/lib.rs"), "utf8");
  const shellMetadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--no-deps",
        "--manifest-path",
        "crates/mobile-shell/Cargo.toml",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  ) as CargoMetadata;

  for (const required of [
    "ShellIntentSource",
    "AndroidChrome",
    "AppleChrome",
    "PlatformDeepLink",
    "PreparedShellIntent",
    "WebEntryDirective",
    "MAX_RETIRED_INTENT_IDS",
  ]) {
    invariant(rust.includes(required), `Shared Rust shell contract is missing ${required}`);
  }
  for (const forbidden of [
    /ReactIntent/u,
    /WebIntent/u,
    /PlatformBack/u,
    /tab_stacks/u,
    /focus_token/u,
    /can_go_back/u,
    /NavigationAction::Back/u,
  ]) {
    invariant(!forbidden.test(rust), `Shared Rust shell owns forbidden Web state: ${forbidden}`);
  }

  invariant(
    !mobileManifest.includes("mish-mobile-shell") && !mobileHost.includes("mish_mobile_shell"),
    "The production mobile application selected the native shell before its cutover Issue.",
  );
  const runtimeDependencies = findRuntimeCargoDependencies(shellMetadata);
  invariant(
    runtimeDependencies.length === 0,
    `The production-disabled shell contract introduced runtime dependencies: ${runtimeDependencies.join(", ")}`,
  );

  console.log(
    `Mobile shell boundary valid across ${sources.length} source files: Native -> Shared Rust -> Web entry only; the production app remains unselected.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkRepositoryMobileShellBoundary();
}
