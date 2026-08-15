import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
export const admissionDocumentPath = "docs/architecture/typescript-cutover-admission.md";

const expectedPocManifests = [
  "poc/package.json",
  "poc/orpc/package.json",
  "poc/xstate/package.json",
  "poc/query-store/package.json",
  "poc/electron/package.json",
  "poc/rn/package.json",
] as const;

const expectedVersions = [
  ["oRPC public packages", "1.15.0"],
  ["XState", "5.32.5"],
  ["@xstate/react", "6.1.0"],
  ["TanStack Query", "5.101.4"],
  ["TanStack Store core", "0.11.1"],
  ["React / React DOM", "19.2.7"],
  ["Electron", "43.4.0"],
  ["React Native", "0.87.0"],
  ["Node.js", ">=22.13.0"],
  ["TypeScript", "7.0.2"],
  ["Vite / Vitest", "8.2.1` / `4.1.10"],
  ["RN Babel core/runtime", "7.29.7"],
  ["RN Community CLI / Android CLI", "20.2.0"],
  ["RN Babel preset, Codegen, Gradle plugin, Metro config, Metro transformer", "0.87.0"],
  ["ws", "8.21.1"],
] as const;

const requiredHeadings = [
  "## Decision and non-negotiable cutover rule",
  "## Accepted dependency and artifact versions",
  "## Target platform boundaries",
  "## Contract-first oRPC and session policy",
  "## XState v5 lifecycle ownership",
  "## Query, Store, and UI state boundary",
  "## Static denylist and production exclusion",
  "## Evidence-to-conclusion traceability",
  "## Exact cumulative cutover worker packets",
  "### Root lock ownership and cumulative reconciliation",
  "### CUT-03 Web importer boundary",
  "### Dependency waves and merge barrier",
  "## Admission checklist",
] as const;

const requiredPolicyTerms = [
  "contract-first oRPC",
  "WebSocket",
  "Event Iterator",
  "MessagePort",
  "Authentication",
  "Version negotiation",
  "Session generation",
  "Correlation",
  "Stale-response rejection",
  "Deadline",
  "Message size",
  "Reconnect/recovery",
  "XState v5",
  "Runtime",
  "Core",
  "VPN-TUN",
  "Profile",
  "Capture",
  "Settings",
  "Updater",
  "RPC session",
  "TanStack Query",
  "TanStack Store",
  "useSyncExternalStore",
] as const;

const requiredDenylistTerms = [
  "Cargo.toml",
  "Cargo.lock",
  "crates/**",
  "mobile-core/**",
  "apps/desktop/src-tauri/**",
  "apps/mobile/src-tauri/**",
  "packages/rpc-client/**",
  "packages/bridge-protocol/**",
  "crates/desktop-bridge/**",
  "crates/state-machine/**",
  "mish_state_machine",
  "JSON-RPC",
  "fallback",
  "dual-write",
  "poc/**",
] as const;

const requiredEvidenceIds = ["E-P0", "E-P1", "E-P2", "E-P3", "E-P4", "E-P5", "E-SYS"] as const;
const packetIds = [
  "CUT-00",
  "CUT-01",
  "CUT-02",
  "CUT-03",
  "CUT-04",
  "CUT-05",
  "CUT-06",
  "CUT-07",
] as const;
const webImporterNames = ["@mish/ui-state", "@mish/orpc-client", "@mish/domain"] as const;

export interface CutoverAdmissionInput {
  readonly document: string;
  readonly pocManifests?: Readonly<Record<string, string>>;
  readonly pocLock?: string;
  readonly productionSources?: Readonly<Record<string, string>>;
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function walk(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(resolve(repositoryRoot, directory), { withFileTypes: true })) {
    if ([".git", "node_modules", "target", "build", "dist"].includes(entry.name)) continue;
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(relativePath, files);
    } else if (
      /\.(?:gradle|json|js|jsx|kt|kts|m|md|mm|rs|toml|ts|tsx|swift|yaml|yml)$/u.test(entry.name)
    ) {
      files.push(relativePath);
    }
  }
  return files;
}

function defaultProductionSources(): Record<string, string> {
  const paths = [
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    ...walk("apps"),
    ...walk("packages"),
    ...walk("resources"),
    ...walk(".github/workflows"),
  ];
  return Object.fromEntries(paths.map((path) => [path, readRepositoryFile(path)]));
}

function defaultPocManifests(): Record<string, string> {
  return Object.fromEntries(expectedPocManifests.map((path) => [path, readRepositoryFile(path)]));
}

function failIfMissing(errors: string[], source: string, value: string, description: string): void {
  if (!source.includes(value)) errors.push(`${description} is missing: ${value}`);
}

function failIfMissingNormalized(
  errors: string[],
  source: string,
  value: string,
  description: string,
): void {
  const normalizedSource = source.replace(/\s+/gu, " ");
  const normalizedValue = value.replace(/\s+/gu, " ").trim();
  if (!normalizedSource.includes(normalizedValue)) {
    errors.push(`${description} is missing: ${value}`);
  }
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function section(document: string, heading: string): string {
  const start = document.indexOf(heading);
  if (start === -1) return "";
  const nextHeading = document.indexOf("\n## ", start + heading.length);
  return document.slice(start, nextHeading === -1 ? document.length : nextHeading);
}

function checkExactPocVersions(
  errors: string[],
  manifests: Readonly<Record<string, string>>,
  lock: string,
): void {
  const exactDependencies: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    "poc/orpc/package.json": {
      "@orpc/client": "1.15.0",
      "@orpc/contract": "1.15.0",
      "@orpc/server": "1.15.0",
      "@orpc/tanstack-query": "1.15.0",
      "@tanstack/query-core": "5.101.4",
    },
    "poc/xstate/package.json": {
      "@xstate/react": "6.1.0",
      react: "19.2.7",
      xstate: "5.32.5",
    },
    "poc/query-store/package.json": {
      "@orpc/client": "1.15.0",
      "@orpc/contract": "1.15.0",
      "@orpc/tanstack-query": "1.15.0",
      "@tanstack/query-core": "5.101.4",
      "@tanstack/react-query": "5.101.4",
      "@tanstack/store": "0.11.1",
      react: "19.2.7",
    },
    "poc/electron/package.json": {
      electron: "43.4.0",
      react: "19.2.7",
      "react-dom": "19.2.7",
      vite: "8.2.1",
    },
    "poc/rn/package.json": {
      "@orpc/client": "1.15.0",
      "@orpc/contract": "1.15.0",
      "@orpc/tanstack-query": "1.15.0",
      "@tanstack/query-core": "5.101.4",
      "@tanstack/react-query": "5.101.4",
      "@tanstack/store": "0.11.1",
      "@xstate/react": "6.1.0",
      react: "19.2.7",
      "react-native": "0.87.0",
      xstate: "5.32.5",
    },
  };

  for (const [path, expectedDependencies] of Object.entries(exactDependencies)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(manifests[path] ?? "") as Record<string, unknown>;
    } catch {
      errors.push(`POC manifest is not valid JSON: ${path}`);
      continue;
    }
    const directDependencies = parsed.dependencies as Record<string, string> | undefined;
    const actual = {
      ...directDependencies,
      ...(parsed.devDependencies as Record<string, string> | undefined),
    };
    for (const [name, version] of Object.entries(expectedDependencies)) {
      if (actual[name] !== version) {
        errors.push(`POC dependency drift in ${path}: ${name} must be exactly ${version}`);
      }
      const devOnly = path === "poc/electron/package.json" && name === "vite";
      if (!devOnly && directDependencies?.[name] !== version) {
        errors.push(`POC runtime dependency must be direct in ${path}: ${name}=${version}`);
      }
    }
  }

  for (const [name, version] of [
    ["@orpc/client", "1.15.0"],
    ["@orpc/contract", "1.15.0"],
    ["@orpc/server", "1.15.0"],
    ["@orpc/tanstack-query", "1.15.0"],
    ["xstate", "5.32.5"],
    ["@tanstack/store", "0.11.1"],
    ["electron", "43.4.0"],
    ["react-native", "0.87.0"],
  ] as const) {
    failIfMissing(errors, lock, `${name}@${version}`, `POC lockfile entry for ${name}`);
  }

  const rootManifest = manifests["poc/package.json"];
  if (!rootManifest?.includes('"node": ">=22.13.0"')) {
    errors.push("POC engine floor must remain Node >=22.13.0");
  }
}

function checkProductionIsolation(
  errors: string[],
  sources: Readonly<Record<string, string>>,
  document: string,
): void {
  const workspace = sources["pnpm-workspace.yaml"];
  if (workspace?.match(/(?:^|\n).*poc(?:\/|\s|$)/iu)) {
    errors.push("production pnpm workspace must not include poc/**");
  }
  for (const [path, source] of Object.entries(sources)) {
    if (/(?:^|\/)(?:apps|packages|resources|\.github|scripts)(?:\/|$)/u.test(path)) {
      if (/poc\//iu.test(source) || /@mish\/poc-/iu.test(source)) {
        errors.push(`production source reaches POC runtime: ${path}`);
      }
    }
  }
  const isolation = section(document, "## Static denylist and production exclusion");
  for (const required of [
    "private, `publish = false` admission fixture",
    "must never be",
    "`.pnpm`",
    "private `/dist/` path",
    "final CUT-07 graph walk",
  ]) {
    failIfMissing(errors, isolation, required, "POC isolation policy");
  }
}

function checkPacketTable(errors: string[], document: string): void {
  const packetSection = section(document, "## Exact cumulative cutover worker packets");
  const rows = [...packetSection.matchAll(/^\| (CUT-\d\d)\b[^|]*\|([^\n]+)$/gmu)];
  const rowIds = rows.map((match) => match[1]);
  const rowsByPacket = new Map(rows.map((match) => [match[1], match[0]]));
  for (const packetId of packetIds) {
    if (!rowIds.includes(packetId)) errors.push(`cutover packet row is missing: ${packetId}`);
  }
  if (new Set(rowIds).size !== rowIds.length) errors.push("cutover packet IDs must be unique");
  for (const match of rows) {
    const row = match[0];
    if (!/\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|/u.test(row)) {
      errors.push(`cutover packet row has the wrong column shape: ${match[1]}`);
    }
    if (!/(?:accept|pass|verify|reject|record)/iu.test(row)) {
      errors.push(`cutover packet row lacks an acceptance clause: ${match[1]}`);
    }
  }
  for (const packetId of ["CUT-01", "CUT-02", "CUT-03", "CUT-04", "CUT-05"] as const) {
    const row = rowsByPacket.get(packetId);
    if (!row?.includes("pnpm-lock.yaml")) {
      errors.push(`cutover packet lock permission is missing: ${packetId}`);
    }
  }
  const cut03 = rowsByPacket.get("CUT-03") ?? "";
  for (const required of [
    "the only additional production manifest `apps/web/package.json`",
    "real Web production consumer",
    "only production `dependencies` entries",
    "workspace:*",
    "pnpm-lock.yaml",
  ]) {
    failIfMissingNormalized(errors, cut03, required, "CUT-03 Web importer scope");
  }
  for (const name of webImporterNames) {
    failIfMissing(errors, cut03, `\`${name}\``, "CUT-03 Web importer dependency");
  }
  const declaredWebImporterNames = [...cut03.matchAll(/`(@mish\/[^`]+)`/gu)].map(
    (match) => match[1],
  );
  const unexpectedWebImporterNames = [
    ...new Set(
      declaredWebImporterNames.filter(
        (name) => !webImporterNames.some((allowed) => allowed === name),
      ),
    ),
  ];
  if (unexpectedWebImporterNames.length > 0) {
    errors.push(
      `CUT-03 Web importer declares unauthorized dependencies: ${unexpectedWebImporterNames.join(", ")}`,
    );
  }
  if (declaredWebImporterNames.length !== webImporterNames.length) {
    errors.push("CUT-03 Web importer must declare exactly the three admitted dependencies");
  }
  const cut06 = rowsByPacket.get("CUT-06") ?? "";
  for (const required of ["final root", "pnpm-lock.yaml", "CI cleanup"]) {
    failIfMissing(errors, cut06, required, "CUT-06 final lock ownership");
  }
  for (const wave of [
    "Wave A: CUT-00",
    "Wave B: CUT-01",
    "Wave C: CUT-02",
    "Wave D: CUT-03 || CUT-04 || CUT-05",
    "Wave E: CUT-06",
    "Wave F: CUT-07",
  ]) {
    failIfMissing(errors, packetSection, wave, "cutover dependency wave");
  }
  for (const required of [
    "same cumulative branch",
    "no partial runtime is merged",
    "maintainer confirmation required",
    "no packet may independently merge",
  ]) {
    failIfMissing(errors, packetSection, required, "cutover merge barrier");
  }

  const lockOwnership = section(document, "### Root lock ownership and cumulative reconciliation");
  for (const required of [
    "same bounded generated-file permission",
    "cumulative root `pnpm-lock.yaml`",
    "codex/typescript-cutover",
    "no packet branch may merge directly to `dev`",
    "parallel CUT-04/CUT-05",
    "lock conflict reconciliation",
    "cumulative integrator",
    "exact versions",
    "preserve every existing importer",
    "frozen install",
    "--frozen-lockfile",
    "no missing importer",
    "CUT-06 remains the final owner",
    "CI cleanup",
  ]) {
    failIfMissing(errors, lockOwnership, required, "root lock ownership policy");
  }

  const webBoundary = section(document, "### CUT-03 Web importer boundary");
  for (const required of [
    "only additional production manifest",
    "real Web production consumer",
    "only production `dependencies` entries",
    "exact `workspace:*` specifier",
    "No root `package.json`",
    "root/apps Web tsconfig",
    "`apps/web/tsconfig*.json`",
    "`pnpm-workspace.yaml`",
    "CI/scripts except `scripts/check-typescript-cutover-admission.ts`",
    "any other app/package manifest is authorized",
    "CUT-06 final root manifest/tsconfig/CI cleanup",
    "later host packet ownership",
    "existing cumulative root `pnpm-lock.yaml` permission remains unchanged",
    "does not change exact library pins",
    "Query/XState/Store responsibilities",
    "dependency waves",
    "one-shot merge barrier",
    "direct `dev` merge prohibition",
    "no release/deploy/real network/VPN/TUN/Core",
    "host effect constraints",
  ]) {
    failIfMissingNormalized(errors, webBoundary, required, "CUT-03 Web importer boundary");
  }
  for (const forbiddenPositive of [
    /(?<!No )root `package\.json`[^.\n]*(?:authorized|in scope|may be updated)/iu,
    /(?<!or )apps\/web\/tsconfig[^.\n]*(?:authorized|in scope|may be updated)/iu,
    /(?<!any )other app\/package manifest[^.\n]*(?:authorized|in scope|may be updated)/iu,
  ]) {
    if (forbiddenPositive.test(webBoundary)) {
      errors.push(`forbidden CUT-03 Web importer scope is documented: ${forbiddenPositive}`);
    }
  }
}

export function validateTypescriptCutoverAdmission(input: CutoverAdmissionInput): string[] {
  const errors: string[] = [];
  const { document } = input;
  for (const heading of requiredHeadings) {
    failIfMissing(errors, document, heading, "admission section");
  }
  for (const term of requiredPolicyTerms) {
    failIfMissing(errors, document, term, "required policy");
  }
  for (const term of requiredDenylistTerms) {
    failIfMissing(
      errors,
      section(document, "## Static denylist and production exclusion"),
      term,
      "static denylist entry",
    );
  }
  for (const id of requiredEvidenceIds) {
    failIfMissing(
      errors,
      section(document, "## Evidence-to-conclusion traceability"),
      id,
      "evidence ID",
    );
  }
  for (const [surface, version] of expectedVersions) {
    const rowPattern = new RegExp(
      `\\|[^\\n]*${escaped(surface)}[^\\n]*\\|[^\\n]*\\x60${escaped(version)}\\x60`,
      "u",
    );
    if (!rowPattern.test(section(document, "## Accepted dependency and artifact versions"))) {
      errors.push(`accepted version row drifted or is missing: ${surface}=${version}`);
    }
  }

  const decision = section(document, "## Decision and non-negotiable cutover rule");
  for (const required of [
    "one cumulative, one-shot architecture cutover",
    "No gradual, incremental",
    "not merged independently",
    "planning, not the merge",
    "no Rust Core",
    "no Rust/Cargo compilation toolchain",
    "no custom JSON-RPC",
    "no Mish-owned general",
    "no old-protocol adapter",
    "no fallback path",
    "no dual write",
  ]) {
    failIfMissing(errors, decision, required, "one-shot cutover rule");
  }
  for (const forbiddenPositive of [
    /(?:gradual|incremental) migration[^.\n]*(?:allowed|permitted)/iu,
    /fallback path[^.\n]*(?:allowed|permitted)/iu,
    /dual[- ]write[^.\n]*(?:allowed|permitted)/iu,
    /partial runtime[^.\n]*(?:allowed|permitted)/iu,
  ]) {
    if (forbiddenPositive.test(document)) {
      errors.push(`forbidden cutover relaxation is documented: ${forbiddenPositive}`);
    }
  }

  const boundaries = section(document, "## Target platform boundaries");
  for (const required of [
    "WebSocket/Event Iterator",
    "Electron uses the oRPC MessagePort adapter",
    "New Architecture/Hermes",
    "@tanstack/react-store",
    "Kotlin, Swift, or Objective-C",
  ]) {
    failIfMissing(errors, boundaries, required, "platform boundary");
  }

  const artifact = section(document, "### Artifact evidence");
  for (const required of [
    "827f9f182566f46846377575b51c547b9926b111637313a373b6f717462aebac",
    "arm64-v8a,x86_64",
    "RN_ADMISSION_OK",
    "emulator-5558",
    "41.82s",
  ]) {
    failIfMissing(errors, artifact, required, "artifact evidence");
  }

  const manifests = input.pocManifests ?? defaultPocManifests();
  const missingManifests = expectedPocManifests.filter((path) => !(path in manifests));
  for (const path of missingManifests) errors.push(`POC manifest evidence is missing: ${path}`);
  const lock = input.pocLock ?? readRepositoryFile("poc/pnpm-lock.yaml");
  checkExactPocVersions(errors, manifests, lock);
  checkProductionIsolation(errors, input.productionSources ?? defaultProductionSources(), document);
  checkPacketTable(errors, document);
  return errors;
}

export function checkTypescriptCutoverAdmission(): void {
  const errors = validateTypescriptCutoverAdmission({
    document: readRepositoryFile(admissionDocumentPath),
  });
  if (errors.length > 0) {
    throw new Error(`TypeScript cutover admission failed:\n- ${errors.join("\n- ")}`);
  }
}

if (process.argv[1] === import.meta.filename) {
  checkTypescriptCutoverAdmission();
  console.log("TypeScript cutover admission record is valid.");
}
