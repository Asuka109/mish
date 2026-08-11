import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const registryPath = "docs/architecture/state-machine-registry.json";
const simulatorDirectory = ["crates", "simulated-host"].join("/");

export interface RegistryEntry {
  id: string;
  classification: "conforming" | "migration-required" | "intentionally-excluded";
  canonicalOwner: string;
  recoveryBoundary: string;
  lifecycleAuthority?: string;
}

export interface LifecycleNonOwner {
  file: string;
  marker: string;
  role: string;
}

export interface LifecycleAuthority {
  id: string;
  machineId: string;
  kernelOwner: string;
  runnerOwner: string;
  domainOwner: string;
  effectOwner: string;
  projectionOwner: string;
  testProjectionOwner: string;
  responsibilities: string[];
  nonOwners: LifecycleNonOwner[];
}

export interface StateMachineRegistry {
  schemaVersion: number;
  classifications: string[];
  lifecycleAuthorities: LifecycleAuthority[];
  machines: RegistryEntry[];
}

export type SourceReader = (relativePath: string) => string | null;
export type SourceInventory = ReadonlyMap<string, string>;

const requiredMachines = [
  "updater-check",
  "updater-maintenance",
  "internal-tun-alpha-package",
  "tun-helper-core-network",
  "runtime-profile-activation",
  "capture-system-proxy",
  "application-core-lifecycle",
  "updater-continuation",
  "settings-backup-transactions",
  "desktop-application-lifecycle",
  "diagnostics-run",
  "bridge-connectivity",
  "platform-observation-adapters",
  "ephemeral-react-interactions",
  "android-fixture-vpn-lifecycle",
  "traffic-source-session",
] as const;

const conformingSources = new Map([
  ["updater-check", "impl Machine for CheckMachine"],
  ["updater-continuation", "impl Machine for ContinuationMachine"],
  ["updater-maintenance", "impl Machine for MaintenanceMachine"],
  ["internal-tun-alpha-package", "impl Machine for PackageMachine"],
  ["tun-helper-core-network", "impl Machine for TunLifecycleMachine"],
  ["runtime-profile-activation", "impl Machine for ProfileActivationMachine"],
  ["capture-system-proxy", "impl Machine for CaptureMachine"],
  ["android-fixture-vpn-lifecycle", "impl Machine for LifecycleMachine"],
  ["traffic-source-session", "impl Machine for TrafficSourceMachine"],
]);

const captureAuthorityId = "capture-owned-operation-lifecycle";
const captureMachineId = "capture-system-proxy";
const captureResponsibilities = [
  "forced-retirement",
  "cancellation",
  "finalization",
  "replacement",
  "shutdown",
] as const;

const lifecycleOwnerMarkers: Readonly<
  Record<
    | "kernelOwner"
    | "runnerOwner"
    | "domainOwner"
    | "effectOwner"
    | "projectionOwner"
    | "testProjectionOwner",
    readonly string[]
  >
> = {
  kernelOwner: ["pub trait Machine", "fn finish_effect", "fn complete_shutdown", "fn drain<"],
  runnerOwner: [
    "runner: RunnerHandle<CaptureMachine>",
    "let runner = spawn_runner(",
    "pub async fn reconcile_for_shutdown",
    "self.runner.shutdown().await",
  ],
  domainOwner: [
    "impl Machine for CaptureMachine",
    "fn finalizer(",
    "fn task_failed(&self, correlation: Correlation, failure: TaskFailure)",
    "fn shutdown(&self) -> Self::Input",
  ],
  effectOwner: ["struct CaptureEffectAdapter", "impl CaptureEffects for CaptureEffectAdapter"],
  projectionOwner: ["impl TransitionObserver<CaptureMachine> for CaptureProjectionObserver"],
  testProjectionOwner: ["CaptureLifecycleObserver", "set_lifecycle_observer"],
};

const authorityDocumentation: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "docs/architecture/state-machine-kernel.md",
    ["## Single lifecycle authority for Capture owned operations", captureAuthorityId],
  ],
  [
    "docs/architecture/runtime-state-ownership.md",
    ["## Capture owned-operation authority", captureAuthorityId],
  ],
  [
    "docs/architecture/state-lifecycle-race-audit.md",
    ["The lifecycle authority is recorded once as", captureAuthorityId],
  ],
];

function source(relativePath: string): string | null {
  try {
    return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
  } catch {
    return null;
  }
}

function productionRustSource(contents: string): string {
  const testModule = contents.search(/\n#\[cfg\((?:all\()?test\b/u);
  return testModule === -1 ? contents : contents.slice(0, testModule);
}

function rustSources(
  relativeDirectory: string,
  inventory = new Map<string, string>(),
): SourceInventory {
  if (relativeDirectory === simulatorDirectory) return inventory;
  const absoluteDirectory = resolve(repositoryRoot, relativeDirectory);
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      rustSources(relativePath, inventory);
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      const contents = source(relativePath);
      if (contents !== null) inventory.set(relativePath, contents);
    }
  }
  return inventory;
}

export function readProductionSources(): SourceInventory {
  const inventory = new Map<string, string>();
  for (const root of ["crates", "apps"]) {
    rustSources(root, inventory);
  }
  return inventory;
}

function hasMarker(contents: string | null, marker: string): boolean {
  return contents !== null && contents.includes(marker);
}

function pathsContaining(inventory: SourceInventory, marker: string): string[] {
  return [...inventory.entries()]
    .filter(([, contents]) => productionRustSource(contents).includes(marker))
    .map(([relativePath]) => relativePath)
    .sort();
}

function pathsContainingAll(inventory: SourceInventory, markers: readonly string[]): string[] {
  return [...inventory.entries()]
    .filter(([, contents]) => {
      const production = productionRustSource(contents);
      return markers.every((marker) => production.includes(marker));
    })
    .map(([relativePath]) => relativePath)
    .sort();
}

export function validateOwnedOperationSources(
  authority: LifecycleAuthority,
  inventory: SourceInventory,
): string[] {
  const failures: string[] = [];
  const production = new Map(
    [...inventory.entries()].map(([path, contents]) => [path, productionRustSource(contents)]),
  );

  const ownerMarkers: ReadonlyArray<readonly [keyof typeof lifecycleOwnerMarkers, string]> = [
    ["kernelOwner", "pub trait Machine"],
    ["runnerOwner", "RunnerHandle<CaptureMachine>"],
    ["domainOwner", "impl Machine for CaptureMachine"],
    ["effectOwner", "struct CaptureEffectAdapter"],
    ["projectionOwner", "impl TransitionObserver<CaptureMachine>"],
  ];
  for (const [ownerKey, marker] of ownerMarkers) {
    const paths = pathsContaining(production, marker);
    const owner = authority[ownerKey];
    const unexpected = paths.filter((path) => path !== owner);
    if (unexpected.length > 0) {
      failures.push(
        `${marker} is owned by ${owner}; unexpected production owner(s): ${unexpected.join(", ")}`,
      );
    }
    if (!paths.includes(owner)) {
      failures.push(`${owner} no longer contains the lifecycle marker ${marker}`);
    }
  }

  const ownerExclusiveMarkers: ReadonlyArray<readonly [string, string]> = [
    ["fn finish_effect", authority.kernelOwner],
    ["async fn drain<", authority.kernelOwner],
    ["CaptureInput::TaskFailed", authority.domainOwner],
    ["CaptureInput::TaskCancelled", authority.domainOwner],
    ["CaptureInput::Shutdown", authority.domainOwner],
    ["CaptureInput::ShutdownFinished", authority.domainOwner],
    ["CaptureEffect::Finalize", authority.domainOwner],
    ["CaptureEffect::Cancel", authority.domainOwner],
    ["CaptureEffect::Shutdown", authority.domainOwner],
    ["fn finalizer(", authority.domainOwner],
    ["RunnerHandle<CaptureMachine>", authority.runnerOwner],
  ];
  for (const [marker, owner] of ownerExclusiveMarkers) {
    for (const path of pathsContaining(production, marker)) {
      if (path !== owner) {
        failures.push(`${marker} bypasses the single Capture lifecycle owner in ${path}`);
      }
    }
  }

  for (const [path, contents] of production) {
    if (path === authority.runnerOwner) continue;
    if (contents.includes("spawn_runner(") && contents.includes("CaptureMachine")) {
      failures.push(`${path} constructs a second Capture runner`);
    }
    if (contents.includes("tokio::spawn") && contents.includes("CaptureMachine")) {
      failures.push(`${path} starts a detached Capture lifecycle task`);
    }
  }

  if (
    pathsContainingAll(production, ["let runner = spawn_runner(", "CaptureMachine"]).length !== 1
  ) {
    failures.push(
      "Capture owned-operation lifecycle must have exactly one production runner construction",
    );
  }
  if (pathsContaining(production, "impl Machine for CaptureMachine").length !== 1) {
    failures.push("CaptureMachine must have exactly one production Machine implementation");
  }
  return failures;
}

export interface RegistryValidationOptions {
  readSource?: SourceReader;
  productionSources?: SourceInventory;
}

export function validateStateMachineRegistry(
  registry: StateMachineRegistry,
  options: RegistryValidationOptions = {},
): string[] {
  const read = options.readSource ?? source;
  const productionSources = options.productionSources ?? readProductionSources();
  const failures: string[] = [];

  if (registry.schemaVersion !== 2) {
    failures.push(`${registryPath} must use schemaVersion 2`);
  }
  if (
    JSON.stringify(registry.classifications) !==
    JSON.stringify(["conforming", "migration-required", "intentionally-excluded"])
  ) {
    failures.push(`${registryPath} must keep the closed classification vocabulary`);
  }

  const ids = new Set<string>();
  for (const machine of registry.machines) {
    if (ids.has(machine.id)) failures.push(`duplicate machine id ${machine.id}`);
    ids.add(machine.id);
    if (!registry.classifications.includes(machine.classification)) {
      failures.push(`${machine.id} has an unknown classification`);
    }
    if (!machine.canonicalOwner || !machine.recoveryBoundary) {
      failures.push(`${machine.id} must name its owner and recovery boundary`);
    }
    const sourceMarker = conformingSources.get(machine.id);
    if (machine.classification === "conforming" && !sourceMarker) {
      failures.push(`${machine.id} is conforming without a source marker`);
    }
    if (sourceMarker) {
      const contents = read(machine.canonicalOwner);
      if (!hasMarker(contents, sourceMarker)) {
        failures.push(`${machine.canonicalOwner} no longer contains ${sourceMarker}`);
      }
    }
  }
  for (const id of requiredMachines) {
    if (!ids.has(id)) failures.push(`required lifecycle ${id} is unclassified`);
  }

  const authorities = Array.isArray(registry.lifecycleAuthorities)
    ? registry.lifecycleAuthorities
    : [];
  const authorityIds = new Set<string>();
  for (const authority of authorities) {
    if (authorityIds.has(authority.id))
      failures.push(`duplicate lifecycle authority ${authority.id}`);
    authorityIds.add(authority.id);
  }
  const captureAuthorities = authorities.filter(
    (authority) => authority.machineId === captureMachineId,
  );
  if (captureAuthorities.length !== 1) {
    failures.push(
      `${captureMachineId} must have exactly one lifecycle authority (found ${captureAuthorities.length})`,
    );
  }
  const authority = authorities.find((candidate) => candidate.id === captureAuthorityId);
  if (!authority) {
    failures.push(`${captureMachineId} is missing ${captureAuthorityId}`);
  } else {
    if (authority.machineId !== captureMachineId) {
      failures.push(`${captureAuthorityId} must own ${captureMachineId}`);
    }
    if (JSON.stringify(authority.responsibilities) !== JSON.stringify(captureResponsibilities)) {
      failures.push(
        `${captureAuthorityId} must name forced-retirement, cancellation, finalization, replacement, and shutdown exactly once`,
      );
    }
    const ownerKeys = [
      "kernelOwner",
      "runnerOwner",
      "domainOwner",
      "effectOwner",
      "projectionOwner",
      "testProjectionOwner",
    ] as const;
    for (const ownerKey of ownerKeys) {
      const ownerPath = authority[ownerKey];
      if (!ownerPath || read(ownerPath) === null) {
        failures.push(`${captureAuthorityId} names missing ${ownerKey} ${ownerPath}`);
      }
      for (const marker of lifecycleOwnerMarkers[ownerKey]) {
        if (!hasMarker(read(ownerPath), marker)) {
          failures.push(`${ownerPath} no longer contains ${marker}`);
        }
      }
    }
    const nonOwnerKeys = new Set<string>();
    for (const nonOwner of authority.nonOwners ?? []) {
      const key = `${nonOwner.file}:${nonOwner.marker}`;
      if (nonOwnerKeys.has(key)) failures.push(`duplicate non-owner declaration ${key}`);
      nonOwnerKeys.add(key);
      if (!hasMarker(read(nonOwner.file), nonOwner.marker)) {
        failures.push(`${nonOwner.file} no longer contains non-owner marker ${nonOwner.marker}`);
      }
    }
    failures.push(...validateOwnedOperationSources(authority, productionSources));
  }

  const captureMachine = registry.machines.find((machine) => machine.id === captureMachineId);
  if (captureMachine?.lifecycleAuthority !== captureAuthorityId) {
    failures.push(`${captureMachineId} must point to lifecycle authority ${captureAuthorityId}`);
  }

  for (const [file, requiredText] of authorityDocumentation) {
    const contents = read(file);
    for (const text of requiredText) {
      if (!hasMarker(contents, text))
        failures.push(`${file} no longer contains ${JSON.stringify(text)}`);
    }
  }
  return failures;
}

export function checkStateMachineRegistry(): void {
  const registry = JSON.parse(
    readFileSync(resolve(repositoryRoot, registryPath), "utf8"),
  ) as StateMachineRegistry;
  const failures = validateStateMachineRegistry(registry);
  if (failures.length > 0) {
    console.error("State-machine registry inspection failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    console.error("Classify every new high-risk lifecycle before adding ad-hoc orchestration.");
    process.exitCode = 1;
  } else {
    console.log(
      `State-machine registry inspection passed (${registry.machines.length} classified lifecycles; one Capture lifecycle authority).`,
    );
  }
}

if (process.argv[1] === import.meta.filename) checkStateMachineRegistry();
