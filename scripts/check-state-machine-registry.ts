import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const registryPath = "docs/architecture/state-machine-registry.json";

interface RegistryEntry {
  id: string;
  classification: "conforming" | "migration-required" | "intentionally-excluded";
  canonicalOwner: string;
  recoveryBoundary: string;
}

interface Registry {
  schemaVersion: number;
  classifications: string[];
  machines: RegistryEntry[];
}

const requiredMachines = [
  "updater-check",
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
] as const;

const conformingSources = new Map([
  ["updater-check", "impl Machine for CheckMachine"],
  ["updater-continuation", "impl Machine for ContinuationMachine"],
  ["internal-tun-alpha-package", "impl Machine for PackageMachine"],
  ["tun-helper-core-network", "impl Machine for TunLifecycleMachine"],
  ["runtime-profile-activation", "impl Machine for ProfileActivationMachine"],
  ["capture-system-proxy", "impl Machine for CaptureMachine"],
  ["android-fixture-vpn-lifecycle", "impl Machine for LifecycleMachine"],
]);

const failures: string[] = [];
const registry = JSON.parse(
  readFileSync(resolve(repositoryRoot, registryPath), "utf8"),
) as Registry;

if (registry.schemaVersion !== 1) failures.push(`${registryPath} must use schemaVersion 1`);
if (
  JSON.stringify(registry.classifications) !==
  JSON.stringify(["conforming", "migration-required", "intentionally-excluded"])
)
  failures.push(`${registryPath} must keep the closed classification vocabulary`);

const ids = new Set<string>();
for (const machine of registry.machines) {
  if (ids.has(machine.id)) failures.push(`duplicate machine id ${machine.id}`);
  ids.add(machine.id);
  if (!registry.classifications.includes(machine.classification))
    failures.push(`${machine.id} has an unknown classification`);
  if (!machine.canonicalOwner || !machine.recoveryBoundary)
    failures.push(`${machine.id} must name its owner and recovery boundary`);
  const sourceMarker = conformingSources.get(machine.id);
  if (machine.classification === "conforming" && !sourceMarker)
    failures.push(`${machine.id} is conforming without a source marker`);
  if (sourceMarker) {
    const source = readFileSync(resolve(repositoryRoot, machine.canonicalOwner), "utf8");
    if (!source.includes(sourceMarker))
      failures.push(`${machine.canonicalOwner} no longer contains ${sourceMarker}`);
  }
}
for (const id of requiredMachines) {
  if (!ids.has(id)) failures.push(`required lifecycle ${id} is unclassified`);
}

if (failures.length > 0) {
  console.error("State-machine registry inspection failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("Classify every new high-risk lifecycle before adding ad-hoc orchestration.");
  process.exitCode = 1;
} else {
  console.log(
    `State-machine registry inspection passed (${registry.machines.length} classified lifecycles).`,
  );
}
