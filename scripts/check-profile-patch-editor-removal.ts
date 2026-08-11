import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** The editor projection was deleted in F2.2; these markers must stay absent. */
export const removedProfilePatchEditorMarkers = [
  "ProfilePatchEditor",
  "ProfilePatchEditorDto",
  "ProfilePatchEditorResult",
  "profile-patch-editor",
  "profilePatchEditor",
  "ProfilePatchAuthority",
  "ProfilePatchAuthorityParams",
  "ProfileReplacePatchesParams",
  "ProfileReplacePatchesCommandSchema",
  "profiles.getPatches",
  "profiles.replacePatches",
  "getPatches",
  "replacePatches",
  "patchLoadFailed",
  "patchSaveFailed",
  "patchSaved",
] as const;

/** Exact Profile localization keys removed with the editor projection. */
export const removedProfilePatchEditorLocalizationKeys = [
  "patchActivationBlocked",
  "patchAdd",
  "patchAddTitle",
  "patchAllSaved",
  "patchCount",
  "patchDisable",
  "patchDisabled",
  "patchDiscard",
  "patchDiscardDescription",
  "patchDiscardTitle",
  "patchEdit",
  "patchEditTitle",
  "patchEditorDescription",
  "patchEditorTitle",
  "patchEmptyDescription",
  "patchEmptyTitle",
  "patchEnable",
  "patchEnabled",
  "patchFixture",
  "patchFormDescription",
  "patchGroupAdd",
  "patchGroupLabel",
  "patchGroupMembers",
  "patchGroupOrder",
  "patchGroupReorder",
  "patchInvalid",
  "patchMembers",
  "patchMembersDescription",
  "patchMoveDown",
  "patchMoveUp",
  "patchPolicyGroup",
  "patchPolicyGroupsTarget",
  "patchPosition",
  "patchPrefix",
  "patchReset",
  "patchRuleDelete",
  "patchRuleDisable",
  "patchRuleInsert",
  "patchRuleProvider",
  "patchRuleSummary",
  "patchRuleTarget",
  "patchRuleType",
  "patchRuleValue",
  "patchRuleValueDescription",
  "patchRulesTarget",
  "patchSave",
  "patchSourceRule",
  "patchStale",
  "patchSuffix",
  "patchType",
  "patchUnsavedChanges",
  "patchUnsavedValidation",
  "patchUpdate",
  "patchValidationConflict",
  "patchValidationDisabled",
  "patchValidationDuplicateLabel",
  "patchValidationDuplicateTarget",
  "patchValidationOrder",
  "patchValidationReference",
  "patchValidationRevision",
  "patchValidationTarget",
  "patchValidationValid",
  "patchValidationValue",
] as const;

export const removedProfilePatchEditorPresentationKeys = [
  "profile.patch-load-failed",
  "profile.patch-save-failed",
  "profile.patch-saved",
] as const;

export const removedProfilePatchEditorFiles = [
  "apps/web/src/components/profile-patch-editor.tsx",
] as const;

export const profilePatchEditorGeneratedFiles = [
  "packages/contracts/src/generated/bridge-protocol.ts",
  "crates/desktop-bridge/src/generated/bridge_protocol.rs",
  "packages/contracts/src/generated/presentation.ts",
  "crates/presentation-contract/src/generated.rs",
  "apps/web/src/i18n/i18n-types.ts",
] as const;

export type ProfilePatchEditorSources = Readonly<Record<string, string | undefined>>;

const sourceExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".m",
  ".mm",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);

const productionWebEntries = [
  "apps/web/src/main.tsx",
  "apps/web/src/window-startup.ts",
  "apps/web/appearance-bootstrap.js",
] as const;

const webSourceExtensions = [".css", ".html", ".js", ".jsx", ".json", ".ts", ".tsx"] as const;

const requiredActiveSources: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["apps/web/src/app-routes.tsx", ['path="profiles"', "loadProfilesPage", "ProfilesPage"]],
  [
    "apps/web/src/pages/profiles-page.tsx",
    [
      "openCreate",
      "closeCreate",
      "createProfile",
      "openHttpsImport",
      "closeImport",
      "preflightHttps",
      "savePreview",
    ],
  ],
  ["apps/web/src/data/profile-provider.tsx", ["preflightHttps", "savePreview"]],
  [
    "apps/web/src/data/rpc-profile-client.ts",
    ["profiles.preflightHttps", "profiles.save", "savePreview"],
  ],
  [
    "packages/contracts/src/index.ts",
    ["profiles.preflightHttps", "profiles.save", "preflightHttps", "savePreview"],
  ],
  ["packages/bridge-protocol/bridge-protocol.json", ["profiles.preflightHttps", "profiles.save"]],
  ["crates/desktop-bridge/src/protocol.rs", ["profiles.preflightHttps", "profiles.save"]],
  [
    "apps/web/src/data/notification-registry.ts",
    ["profile.import-failed", "profile.save-failed", "profile.saved"],
  ],
  [
    "packages/presentation-schema/presentation.schema.json",
    ["profile.import-failed", "profile.save-failed", "profile.saved"],
  ],
  ["apps/web/src/i18n/en/index.ts", ["preflight:", "saveProfile:", "checkAndSave:"]],
  ["apps/web/src/i18n/zh/index.ts", ["preflight:", "saveProfile:", "checkAndSave:"]],
];

const generationGateSources = [
  "scripts/check-bridge-protocol-generated.ts",
  "scripts/check-presentation-generated.ts",
  "scripts/check-i18n-generated.ts",
] as const;

function read(relativePath: string): string | undefined {
  const absolutePath = resolve(repositoryRoot, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : undefined;
}

function filesUnder(relativeDirectory: string): string[] {
  const absoluteDirectory = resolve(repositoryRoot, relativeDirectory);
  if (!existsSync(absoluteDirectory)) return [];
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "target" || entry.name === "dist") {
      return [];
    }
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return filesUnder(relativePath);
    return entry.isFile() && sourceExtensions.has(extname(entry.name)) ? [relativePath] : [];
  });
}

/** Read the product/static inventory used by the persistent gate and its fixtures. */
export function readProfilePatchEditorSources(): Record<string, string | undefined> {
  const paths = new Set<string>([
    "package.json",
    ...profilePatchEditorGeneratedFiles,
    ...generationGateSources,
    ...requiredActiveSources.map(([path]) => path),
    ...["apps", "packages", "crates", "mobile-core"].flatMap(filesUnder),
  ]);
  return Object.fromEntries(
    [...paths].map((path) => [path.replaceAll("\\", "/"), read(path)] as const),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKey(source: string, key: string): boolean {
  return new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*:`, "u").test(source);
}

function profilesLocaleBlock(source: string): string {
  const match = source.match(/^  profiles: \{[\s\S]*?^  \},?$/mu);
  return match?.[0] ?? "";
}

function extractLocalImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^;]*?\sfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith(".")) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolveLocalSource(
  from: string,
  specifier: string,
  sources: ProfilePatchEditorSources,
): string | undefined {
  const cleanSpecifier = specifier.split(/[?#]/u, 1)[0] ?? specifier;
  const base = normalize(join(from, "..", cleanSpecifier)).replaceAll("\\", "/");
  const candidates = [
    base,
    ...webSourceExtensions.map((extension) => `${base}${extension}`),
    ...webSourceExtensions.map((extension) => join(base, `index${extension}`)),
  ].map((path) => path.replaceAll("\\", "/"));
  return candidates.find((candidate) => sources[candidate] !== undefined);
}

function productionWebGraph(sources: ProfilePatchEditorSources): Map<string, string> {
  const pending = [...productionWebEntries];
  const visited = new Map<string, string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    const source = sources[path];
    if (source === undefined) continue;
    visited.set(path, source);
    for (const specifier of extractLocalImportSpecifiers(source)) {
      const target = resolveLocalSource(path, specifier, sources);
      if (target !== undefined) pending.push(target);
    }
  }
  return visited;
}

function requiredTextFailures(
  sources: ProfilePatchEditorSources,
  required: ReadonlyArray<readonly [string, readonly string[]]>,
): string[] {
  const failures: string[] = [];
  for (const [path, markers] of required) {
    const source = sources[path];
    if (source === undefined) {
      failures.push(`${path} is missing from the Profile static contract inventory`);
      continue;
    }
    for (const marker of markers) {
      if (!source.includes(marker)) failures.push(`${path} is missing active marker ${marker}`);
    }
  }
  return failures;
}

export function validateProfilePatchEditorRemoval(sources: ProfilePatchEditorSources): string[] {
  const failures: string[] = [];
  const availableSources = Object.entries(sources).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );

  for (const path of removedProfilePatchEditorFiles) {
    if (sources[path] !== undefined) failures.push(`${path} must remain deleted`);
  }

  for (const [path, source] of availableSources) {
    for (const marker of removedProfilePatchEditorMarkers) {
      // The package script intentionally names this gate; all product/static
      // sources must still remain free of the retired module marker.
      if (path === "package.json" && marker === "profile-patch-editor") continue;
      if (source.includes(marker)) {
        failures.push(`${path} reintroduces removed Profile Patch Editor marker ${marker}`);
      }
    }
    for (const marker of removedProfilePatchEditorPresentationKeys) {
      if (source.includes(marker)) {
        failures.push(`${path} reintroduces removed presentation key ${marker}`);
      }
    }
  }

  const routeSource = sources["apps/web/src/app-routes.tsx"];
  if (routeSource !== undefined) {
    if (/path=["'][^"']*profiles[^"']*patch/iu.test(routeSource)) {
      failures.push("apps/web/src/app-routes.tsx exposes a removed Profile Patch Editor route");
    }
    if (/to=["'][^"']*profiles[^"']*patch/iu.test(routeSource)) {
      failures.push(
        "apps/web/src/app-routes.tsx redirects to a removed Profile Patch Editor route",
      );
    }
  }

  for (const [path, source] of Object.entries(sources)) {
    if (source === undefined || !path.startsWith("apps/web/")) continue;
    for (const specifier of extractLocalImportSpecifiers(source)) {
      if (/profile[-_]?patch[-_]?editor/iu.test(specifier)) {
        failures.push(`${path} contains a dangling Profile Patch Editor import ${specifier}`);
      }
    }
  }

  failures.push(...requiredTextFailures(sources, requiredActiveSources));

  for (const path of generationGateSources) {
    if (sources[path] === undefined)
      failures.push(`${path} is missing from generation gate inventory`);
  }
  const packageManifest = sources["package.json"];
  if (packageManifest === undefined) {
    failures.push("package.json is missing from the Profile static contract inventory");
  } else {
    for (const path of generationGateSources) {
      if (!packageManifest.includes(path)) {
        failures.push(`package.json must retain the ${path} generation check`);
      }
    }
    if (!packageManifest.includes("check-profile-patch-editor-removal.ts")) {
      failures.push("package.json must run the Profile Patch Editor removal gate");
    }
  }

  for (const [path, source] of Object.entries(sources)) {
    if (!path.includes("/i18n/") || !path.endsWith("/index.ts") || source === undefined) continue;
    for (const key of removedProfilePatchEditorLocalizationKeys) {
      if (containsKey(source, key)) {
        failures.push(`${path} reintroduces removed Profile localization key ${key}`);
      }
    }
    if (profilesLocaleBlock(source) && containsKey(profilesLocaleBlock(source), "patches")) {
      failures.push(`${path} reintroduces removed Profile localization key patches`);
    }
  }

  const graph = productionWebGraph(sources);
  for (const [path, source] of graph) {
    if (/(?:^|[/.])[^/]*\.test\.[^/]+$/u.test(path) || path.includes("/system-tests/")) {
      failures.push(`production Web graph reaches test-only source ${path}`);
    }
    for (const marker of removedProfilePatchEditorMarkers) {
      if (source.includes(marker)) {
        failures.push(
          `production Web graph reaches removed Profile Patch Editor marker ${marker} in ${path}`,
        );
      }
    }
  }

  return [...new Set(failures)];
}

export function checkProfilePatchEditorRemoval(): void {
  const failures = validateProfilePatchEditorRemoval(readProfilePatchEditorSources());
  if (failures.length > 0) {
    throw new Error(`Profile Patch Editor removal gate failed:\n${failures.join("\n")}`);
  }
}

if (process.argv[1] === import.meta.filename) {
  checkProfilePatchEditorRemoval();
  console.log(
    "Profile Patch Editor removal gate passed: routes, static contracts, generated artifacts, and production Web reachability remain clean.",
  );
}
