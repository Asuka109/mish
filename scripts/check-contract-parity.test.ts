import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  canonicalJson,
  runParityGate,
  validateContractEvidence,
  validateFixture,
} from "./check-contract-parity.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const inventory = JSON.parse(
  readFileSync(resolve(repositoryRoot, "packages/contracts/migration-inventory.json"), "utf8"),
);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function contract(id: string) {
  const found = inventory.contracts.find((candidate: { id: string }) => candidate.id === id);
  assert.ok(found, `missing inventory contract ${id}`);
  return found;
}

function fixtureFor(id: string) {
  const entry = contract(id);
  return JSON.parse(readFileSync(resolve(repositoryRoot, entry.fixture), "utf8"));
}

test("checked inventory and golden fixtures pass the complete parity gate", () => {
  assert.doesNotThrow(() => runParityGate(inventory));
});

test("canonical JSON is key-order independent but array-order preserving", () => {
  assert.equal(
    canonicalJson({ b: 2, a: 1, nested: { z: true, y: false } }),
    '{"a":1,"b":2,"nested":{"y":false,"z":true}}\n',
  );
  assert.equal(
    canonicalJson({ a: ["first", "second"] }),
    canonicalJson({ a: ["first", "second"] }),
  );
  assert.notEqual(
    canonicalJson({ a: ["first", "second"] }),
    canonicalJson({ a: ["second", "first"] }),
  );
});

test("fixture gate rejects missing, extra, unknown, and over-sized data", () => {
  const settings = contract("settings");
  const valid = fixtureFor("settings");
  assert.doesNotThrow(() => validateFixture(settings, valid));

  const missing = clone(valid);
  delete missing.payload.ports;
  assert.throws(() => validateFixture(settings, missing), /fixture payload fields drifted/);

  const extra = clone(valid);
  extra.payload.unlisted = false;
  assert.throws(() => validateFixture(settings, extra), /fixture payload fields drifted/);

  const denied = clone(valid);
  denied.payload.token = "redacted";
  assert.throws(() => validateFixture(settings, denied), /denied privacy shape/);

  assert.throws(() => validateFixture(settings, valid, 1), /exceeds 1 bytes/);
});

test("field, nullable, enum, tag, bound, and compatibility drift fail closed", () => {
  const settings = clone(contract("settings"));
  settings.manualEvidence.shapes[0].wireFields =
    settings.manualEvidence.shapes[0].wireFields.slice(1);
  assert.throws(() => validateContractEvidence(settings), /fields drifted/);

  const extraField = clone(contract("settings"));
  extraField.manualEvidence.shapes[0].wireFields.push("unexpected");
  assert.throws(() => validateContractEvidence(extraField), /fields drifted/);

  const nullableDrift = clone(contract("settings"));
  nullableDrift.manualEvidence.shapes[0].nullableFields = ["networkDns"];
  assert.throws(() => validateContractEvidence(nullableDrift), /nullable fields drifted/);

  const enumDrift = clone(contract("settings"));
  enumDrift.manualEvidence.enums[0].values.push("future-adapter");
  assert.throws(() => validateContractEvidence(enumDrift), /enum variants drifted/);

  const tagDrift = clone(contract("presentation"));
  tagDrift.discriminants.typescript = "type";
  assert.throws(() => validateContractEvidence(tagDrift), /discriminants drifted/);

  const boundDrift = clone(contract("settings"));
  boundDrift.manualEvidence.bounds[0].typescript.marker =
    "controller: z.number().int().min(1).max(1)";
  assert.throws(() => validateContractEvidence(boundDrift), /bound marker/);

  const compatibilityDrift = clone(contract("bridge-protocol"));
  compatibilityDrift.compatibility.version = 39;
  assert.throws(
    () => validateContractEvidence(compatibilityDrift),
    /compatibility version drifted/,
  );

  const markerDrift = clone(contract("mobile-route-vpn"));
  markerDrift.compatibility.rustMarkers[0].marker = "const CONTRACT_VERSION: u8 = 2;";
  assert.throws(() => validateContractEvidence(markerDrift), /compatibility marker/);
});
