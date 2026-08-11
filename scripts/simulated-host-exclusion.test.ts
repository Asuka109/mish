import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const simulatedPackage = "mish-simulated-host";
const simulatedPath = "crates/simulated-host";
const boundedSimulatedApplicationContract =
  "cargo test -p mish-simulated-host --all-features -- --test-threads=1 && pnpm test:browser:simulated-host";
const approvedCiContractDeclaration = `const simulatedApplicationContract =
  "${boundedSimulatedApplicationContract}";`;
const boundedPortableRustClippyContract =
  "cargo clippy --workspace --all-targets --exclude mish-desktop --exclude mish-mobile --exclude tauri-plugin-mish-vpn --exclude mish-platform-macos --exclude mish-simulated-host --exclude mish-updater --exclude mish-bridge --no-deps -- -D warnings && cargo clippy -p mish-updater --lib -- -D warnings";
const forbiddenArtifactMarkers = [
  "MISH_SIMULATED_SCENARIO",
  "TEST_AUTH_TOKEN",
  "TEST_CONTROL_KEY",
  "MaintenanceScenarioRuntime",
  "SemanticTranscript",
  "SyntheticAuthorityId",
  "scenario-harness",
  "test-activation-host",
  "test-correlation",
];

interface CargoMetadata {
  packages: Array<{
    dependencies: Array<{ name: string }>;
    manifest_path: string;
    name: string;
    publish: null | string[];
    features: Record<string, string[]>;
    targets: Array<{
      kind: string[];
      name: string;
      "required-features"?: string[];
    }>;
  }>;
}

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

type SourceReader = (relativePath: string) => string | null;

const webProductionEntries = [
  "apps/web/appearance-bootstrap.js",
  "apps/web/src/main.tsx",
  "apps/web/src/window-startup.ts",
] as const;

const webSourceExtensions = [".js", ".jsx", ".ts", ".tsx"] as const;
const browserOnlyWebPathMarkers = [
  `${path.sep}src${path.sep}system-tests${path.sep}`,
  `${path.sep}src${path.sep}test${path.sep}`,
];
const browserOnlyWebFilePattern = /\.(?:browser\.)?test\.(?:js|jsx|ts|tsx)$/u;
const simulatedControlMarkers = [
  "MISH_SIMULATED_SCENARIO",
  "TEST_AUTH_TOKEN",
  "TEST_CONTROL_KEY",
  "SimulatedHost",
  "scenario-harness",
  "simulated-host",
];

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
  hasSource: (relativePath: string) => boolean,
): string | null {
  const cleanSpecifier = specifier.split(/[?#]/u, 1)[0] ?? specifier;
  const base = path.normalize(path.join(path.dirname(from), cleanSpecifier));
  const candidates = [
    base,
    ...webSourceExtensions.map((extension) => `${base}${extension}`),
    ...webSourceExtensions.map((extension) => path.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => hasSource(candidate)) ?? null;
}

function findWebProductionGraphViolations(
  entries: readonly string[],
  readSource: SourceReader,
): string[] {
  const pending = entries.map((entry) => path.normalize(entry));
  const visited = new Set<string>();
  const violations = new Set<string>();

  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (!relativePath || visited.has(relativePath)) continue;
    visited.add(relativePath);

    const source = readSource(relativePath);
    if (source === null) continue;

    if (
      browserOnlyWebPathMarkers.some((marker) => relativePath.includes(marker)) ||
      browserOnlyWebFilePattern.test(relativePath)
    ) {
      violations.add(`test-only Web source reachable: ${relativePath}`);
    }
    for (const marker of simulatedControlMarkers) {
      if (source.includes(marker)) {
        violations.add(
          `simulated control marker reachable from Web production graph: ${relativePath} (${marker})`,
        );
      }
    }

    for (const specifier of extractLocalImportSpecifiers(source)) {
      const target = resolveLocalSource(
        relativePath,
        specifier,
        (candidate) => readSource(candidate) !== null,
      );
      if (target !== null) pending.push(target);
    }
  }

  return [...violations].sort();
}

function readWebProductionSource(relativePath: string): string | null {
  if (
    !webSourceExtensions.includes(
      path.extname(relativePath) as (typeof webSourceExtensions)[number],
    )
  ) {
    return null;
  }
  const absolutePath = path.join(repositoryRoot, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null;
}

function filesUnder(relativeDirectory: string): string[] {
  return readdirSync(path.join(repositoryRoot, relativeDirectory), { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return filesUnder(relativePath);
      return entry.isFile() ? [relativePath] : [];
    },
  );
}

function cargoMetadata(): CargoMetadata {
  return JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
  ) as CargoMetadata;
}

test("SimulatedHost is a non-publishable feature-gated test package", () => {
  const metadata = cargoMetadata();
  const simulated = metadata.packages.find(({ name }) => name === simulatedPackage);
  assert.ok(simulated, "The repository-owned SimulatedHost package is missing.");
  assert.deepEqual(simulated.publish, [], "SimulatedHost must remain publish = false.");

  const harness = simulated.targets.find(({ name }) => name === simulatedPackage);
  assert.ok(harness?.kind.includes("bin"), "The scenario harness binary is missing.");
  assert.deepEqual(
    harness["required-features"],
    ["scenario-harness"],
    "The scenario control server must require its test-only feature.",
  );
});

test("no product Rust package can reach SimulatedHost", () => {
  const metadata = cargoMetadata();
  const dependants = metadata.packages
    .filter(({ name }) => name !== simulatedPackage)
    .filter(({ dependencies }) => dependencies.some(({ name }) => name === simulatedPackage))
    .map(({ name }) => name);
  assert.deepEqual(
    dependants,
    [],
    `Production Cargo graphs gained a SimulatedHost dependency: ${dependants.join(", ")}`,
  );

  for (const packageName of [
    "mish-desktop",
    "mish-mobile",
    "mish-bridge",
    "mish-platform-macos",
    "mish-updater",
  ]) {
    assert.ok(
      metadata.packages.some(({ name }) => name === packageName),
      `Production package root is missing from the exclusion proof: ${packageName}`,
    );
  }
});

test("product Rust feature graphs exclude the simulator-only seams", () => {
  for (const packageName of [
    "mish-desktop",
    "mish-mobile",
    "mish-bridge",
    "mish-platform-macos",
    "mish-updater",
  ]) {
    const tree = execFileSync("cargo", ["tree", "-p", packageName, "-e", "features"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(
      tree.includes("test-activation-host") || tree.includes("test-correlation"),
      false,
      `${packageName} enables a simulator-only Rust seam.`,
    );
  }
});

test("Internal TUN maintenance simulation remains confined to the non-publishable package", () => {
  const metadata = cargoMetadata();
  const simulated = metadata.packages.find(({ name }) => name === simulatedPackage);
  assert.ok(simulated, "The Internal TUN simulator package is missing.");
  assert.equal(
    simulated.manifest_path.endsWith("/crates/simulated-host/Cargo.toml"),
    true,
    "Internal TUN maintenance must remain in the dedicated simulator package.",
  );
  assert.equal(
    read("crates/simulated-host/Cargo.toml").includes("publish = false"),
    true,
    "Internal TUN maintenance must remain non-publishable.",
  );

  const productManifests = [
    "crates/desktop-bridge/Cargo.toml",
    "crates/platform-macos/Cargo.toml",
    "crates/runtime/Cargo.toml",
    "crates/settings/Cargo.toml",
  ];
  for (const manifest of productManifests) {
    assert.equal(
      read(manifest).includes(simulatedPackage),
      false,
      `${manifest} reaches the Internal TUN simulation package.`,
    );
  }

  const simulatorSources = filesUnder(simulatedPath).filter((file) => file.endsWith(".rs"));
  assert.ok(
    simulatorSources.some((file) => file.endsWith("internal_tun.rs")),
    "The closed Internal TUN model is missing from the simulator package.",
  );
  for (const sourceRoot of [
    "crates/desktop-bridge/src",
    "crates/platform-macos/src",
    "crates/runtime/src",
    "crates/settings/src",
  ]) {
    const leaked = filesUnder(sourceRoot).filter((file) => {
      const content = read(file);
      return (
        content.includes("MaintenanceScenarioRuntime") ||
        content.includes("SyntheticMaintenanceInitial") ||
        content.includes("mish_simulated_host")
      );
    });
    assert.deepEqual(
      leaked,
      [],
      `${sourceRoot} imports an Internal TUN simulator-only type: ${leaked.join(", ")}`,
    );
  }
});

test("release, signed, updater, Internal TUN, desktop, and mobile inputs exclude SimulatedHost", () => {
  const releaseInputs = [
    ...filesUnder(".github").filter((file) => file !== ".github/platform-target-policy.json"),
    ...filesUnder("apps/desktop"),
    ...filesUnder("apps/mobile"),
    ...filesUnder("scripts").filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.endsWith("check-simulated-host-exclusion.ts") &&
        !file.includes("node_modules"),
    ),
  ].filter((file) => !file.includes("node_modules"));

  for (const file of releaseInputs) {
    const content = read(file);
    // The CI contract validator may name this one bounded test command solely to reject drift.
    // Strip that exact declaration, then retain the product-input exclusion for every other
    // simulator reference in the validator and all other release inputs.
    let checkedContent = file.endsWith("check-ci-workflow.ts")
      ? content.replace(approvedCiContractDeclaration, "")
      : content;
    if (file.endsWith("check-ci-workflow.ts") || file.endsWith("check-trusted-ci-policy.ts")) {
      checkedContent = checkedContent.replaceAll(
        JSON.stringify(boundedPortableRustClippyContract),
        "",
      );
    }
    const leakedMarkers = forbiddenArtifactMarkers.filter((marker) =>
      checkedContent.includes(marker),
    );
    assert.equal(
      checkedContent.includes(simulatedPackage) ||
        checkedContent.includes(simulatedPath) ||
        leakedMarkers.length > 0,
      false,
      `${file} makes test-only SimulatedHost data reachable from a release or product input: ${leakedMarkers.join(", ")}`,
    );
  }
});

test("Web production sources cannot import the scenario control API or synthetic identities", () => {
  const references = filesUnder("apps/web/src").filter((file) => {
    const content = read(file);
    return content.includes("simulatedHost") || content.includes("simulated-host");
  });
  assert.ok(references.length > 0, "The real-browser SimulatedHost scenario is missing.");
  assert.equal(
    references.every((file) => file.startsWith("apps/web/src/system-tests/")),
    true,
    `SimulatedHost escaped its test-only Web source directory: ${references.join(", ")}`,
  );

  for (const file of [
    "apps/web/vite.config.ts",
    "apps/web/vite.desktop.config.ts",
    "apps/web/vite.mobile.config.ts",
  ].filter((candidate) => {
    try {
      read(candidate);
      return true;
    } catch {
      return false;
    }
  })) {
    assert.equal(
      read(file).includes("simulated-host"),
      false,
      `${file} imports the test-only scenario graph.`,
    );
  }
});

test("Web production graph fixture accepts a product-only entry", () => {
  const sources = new Map([
    ["apps/web/src/main.tsx", 'import "./app";'],
    ["apps/web/src/app.tsx", "export {};"],
  ]);

  assert.deepEqual(
    findWebProductionGraphViolations(
      ["apps/web/src/main.tsx"],
      (relativePath) => sources.get(relativePath) ?? null,
    ),
    [],
  );
});

test("Web production graph fixture rejects a browser-only simulated control import", () => {
  const fixturePath = "apps/web/src/components/browser-fixture.browser.test.tsx";
  const sources = new Map([
    ["apps/web/src/main.tsx", 'import "./components/browser-fixture.browser.test";'],
    [fixturePath, "export const scenario = MISH_SIMULATED_SCENARIO;"],
  ]);

  assert.deepEqual(
    findWebProductionGraphViolations(
      ["apps/web/src/main.tsx"],
      (relativePath) => sources.get(relativePath) ?? null,
    ),
    [
      `simulated control marker reachable from Web production graph: ${fixturePath} (MISH_SIMULATED_SCENARIO)`,
      `test-only Web source reachable: ${fixturePath}`,
    ],
  );
});

test("Web production entries exclude Browser Mode fixtures and simulated controls", () => {
  const missingEntries = webProductionEntries.filter(
    (entry) => readWebProductionSource(entry) === null,
  );
  assert.deepEqual(
    missingEntries,
    [],
    "The Web production graph entry list drifted from the bundle.",
  );
  assert.deepEqual(
    findWebProductionGraphViolations(webProductionEntries, readWebProductionSource),
    [],
  );
});

test("product JavaScript package graphs exclude the transport mock", () => {
  for (const manifest of [
    "apps/desktop/package.json",
    "apps/mobile/package.json",
    "apps/web/package.json",
  ]) {
    assert.equal(
      read(manifest).includes("@mish/mock-bridge"),
      false,
      `${manifest} makes the test-only transport mock reachable from a product bundle.`,
    );
  }
});
