import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const simulatedPackage = "mish-simulated-host";
const simulatedPath = "crates/simulated-host";
const boundedInternalTunMaintenanceContract =
  "cargo test -p mish-simulated-host --test internal_tun_maintenance -- --test-threads=1";
const approvedCiContractDeclaration = `const internalTunMaintenanceContract =
  "${boundedInternalTunMaintenanceContract}";`;

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
    ...filesUnder(".github"),
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
    const checkedContent = file.endsWith("check-ci-workflow.ts")
      ? content.replace(approvedCiContractDeclaration, "")
      : content;
    assert.equal(
      checkedContent.includes(simulatedPackage) || checkedContent.includes(simulatedPath),
      false,
      `${file} makes test-only SimulatedHost reachable from a release or product input.`,
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
