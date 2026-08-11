import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  readProductionSources,
  validateOwnedOperationSources,
  validateStateMachineRegistry,
  type LifecycleAuthority,
  type StateMachineRegistry,
} from "./check-state-machine-registry.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

function repositoryFixture(): StateMachineRegistry {
  return JSON.parse(
    readFileSync(resolve(repositoryRoot, "docs/architecture/state-machine-registry.json"), "utf8"),
  ) as StateMachineRegistry;
}

function captureAuthority(registry: StateMachineRegistry): LifecycleAuthority {
  const authority = registry.lifecycleAuthorities.find(
    (candidate) => candidate.id === "capture-owned-operation-lifecycle",
  );
  assert.ok(authority);
  return authority;
}

test("Capture lifecycle registry and production ownership inventory are valid", () => {
  assert.deepEqual(validateStateMachineRegistry(repositoryFixture()), []);
});

test("a second Capture runner fails closed", () => {
  const registry = repositoryFixture();
  const productionSources = new Map(readProductionSources());
  productionSources.set(
    "crates/runtime/src/capture/rogue-runner.rs",
    "fn rogue() { let runner = spawn_runner(CaptureMachine, state, executor, observer, config); }",
  );

  assert.match(
    validateOwnedOperationSources(captureAuthority(registry), productionSources).join("\n"),
    /second Capture runner|exactly one production runner/u,
  );
});

test("a direct Capture finalizer input fails closed", () => {
  const registry = repositoryFixture();
  const productionSources = new Map(readProductionSources());
  productionSources.set(
    "crates/runtime/src/capture/rogue-finalizer.rs",
    "fn rogue() { let effect = CaptureEffect::Finalize { request }; }",
  );

  assert.match(
    validateOwnedOperationSources(captureAuthority(registry), productionSources).join("\n"),
    /CaptureEffect::Finalize bypasses the single Capture lifecycle owner/u,
  );
});

test("SimulatedHost is excluded from the production owner inventory", () => {
  assert.equal(
    [...readProductionSources().keys()].some((path) => path.startsWith("crates/simulated-host/")),
    false,
  );
});
