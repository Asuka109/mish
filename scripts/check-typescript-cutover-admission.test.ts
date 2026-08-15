import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  admissionDocumentPath,
  checkTypescriptCutoverAdmission,
  type CutoverAdmissionInput,
  validateTypescriptCutoverAdmission,
} from "./check-typescript-cutover-admission.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

function document(): string {
  return readFileSync(resolve(repositoryRoot, admissionDocumentPath), "utf8");
}

function validInput(overrides: Partial<CutoverAdmissionInput> = {}): CutoverAdmissionInput {
  return { document: document(), ...overrides };
}

test("the committed TypeScript cutover admission record passes", () => {
  assert.doesNotThrow(checkTypescriptCutoverAdmission);
  assert.deepEqual(validateTypescriptCutoverAdmission(validInput()), []);
});

test("the current CUT-03 Web denial boundary passes without a false positive", () => {
  assert.deepEqual(validateTypescriptCutoverAdmission(validInput()), []);
});

test("a missing required session policy fails closed", () => {
  const drifted = document().replace(/\| Deadline\s+\|/u, "| Time budget | ");
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(errors.join("\n"), /required policy is missing: Deadline/u);
});

test("an exact dependency version drift fails closed", () => {
  const drifted = document().replace(
    "| oRPC public packages (`@orpc/client`, `@orpc/contract`, `@orpc/server`, `@orpc/tanstack-query`) | `1.15.0`",
    "| oRPC public packages (`@orpc/client`, `@orpc/contract`, `@orpc/server`, `@orpc/tanstack-query`) | `1.15.1`",
  );
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(
    errors.join("\n"),
    /accepted version row drifted or is missing: oRPC public packages=1\.15\.0/u,
  );
});

test("a POC manifest version drift fails closed even when the document is unchanged", () => {
  const manifests = {
    "poc/orpc/package.json": readFileSync(
      resolve(repositoryRoot, "poc/orpc/package.json"),
      "utf8",
    ).replace('"@orpc/client": "1.15.0"', '"@orpc/client": "1.15.1"'),
  } as Record<string, string>;
  for (const path of [
    "poc/package.json",
    "poc/xstate/package.json",
    "poc/query-store/package.json",
    "poc/electron/package.json",
    "poc/rn/package.json",
  ]) {
    manifests[path] = readFileSync(resolve(repositoryRoot, path), "utf8");
  }
  const errors = validateTypescriptCutoverAdmission({
    document: document(),
    pocManifests: manifests,
  });
  assert.match(errors.join("\n"), /POC dependency drift in poc\/orpc\/package\.json/u);
});

test("removing a hard-deletion denylist entry is rejected", () => {
  const drifted = document().replace("`packages/rpc-client/**`, ", "");
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(errors.join("\n"), /static denylist entry is missing: packages\/rpc-client\/\*\*/u);
});

test("a fallback relaxation is rejected instead of becoming a migration escape hatch", () => {
  const drifted = document().replace("no fallback path", "fallback path is allowed");
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(errors.join("\n"), /forbidden cutover relaxation is documented/u);
});

test("a production import of POC runtime is rejected", () => {
  const errors = validateTypescriptCutoverAdmission({
    document: document(),
    productionSources: {
      "apps/web/src/poc-leak.ts": 'import { PolicySession } from "@mish/poc-orpc";\n',
    },
  });
  assert.match(errors.join("\n"), /production source reaches POC runtime/u);
});

test("a POC workspace edge is rejected", () => {
  const errors = validateTypescriptCutoverAdmission({
    document: document(),
    productionSources: {
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - poc/*\n",
    },
  });
  assert.match(errors.join("\n"), /production pnpm workspace must not include poc/u);
});

test("a missing packet row is rejected", () => {
  const drifted = document().replace(/^\| CUT-07 Final cumulative acceptance[^\n]*\n/mu, "");
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(errors.join("\n"), /cutover packet row is missing: CUT-07/u);
});

test("a packet without an acceptance clause is rejected", () => {
  const drifted = document().replace(
    "Acceptance passes with a dual-ABI debug build",
    "The packet delivers a dual-ABI debug build",
  );
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(errors.join("\n"), /cutover packet row lacks an acceptance clause: CUT-05/u);
});

test("removing one packet's cumulative lock permission is rejected", () => {
  const drifted = document().replace(
    "New `packages/domain/**`, actor tests, and bounded generated updates to the cumulative root `pnpm-lock.yaml` for exact packet dependencies only",
    "New `packages/domain/**` and actor tests only",
  );
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(errors.join("\n"), /cutover packet lock permission is missing: CUT-02/u);
});

test("removing cumulative lock conflict reconciliation is rejected", () => {
  const drifted = document().replace(
    "performs lock conflict reconciliation sequentially",
    "performs lock reconciliation sequentially",
  );
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(
    errors.join("\n"),
    /root lock ownership policy is missing: lock conflict reconciliation/u,
  );
});

test("removing frozen-install or no-missing-importer acceptance is rejected", () => {
  const drifted = document()
    .replace("run the frozen install", "run the install")
    .replace("verify\nno missing importer", "verify\nan importer");
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(errors.join("\n"), /root lock ownership policy is missing: frozen install/u);
  assert.match(errors.join("\n"), /root lock ownership policy is missing: no missing importer/u);
});

test("removing the CUT-03 Web importer manifest permission is rejected", () => {
  const drifted = document().replace(
    "the only additional production manifest `apps/web/package.json` for the real Web production consumer",
    "the only additional production manifest for the real Web production consumer",
  );
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(
    errors.join("\n"),
    /CUT-03 Web importer scope is missing: the only additional production manifest `apps\/web\/package\.json`/u,
  );
});

test("a non-workspace CUT-03 Web dependency specifier is rejected", () => {
  const drifted = document().replace(
    "and `@mish/domain`, each using exact `workspace:*`",
    "and `@mish/domain`, each using exact `workspace:^`",
  );
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(errors.join("\n"), /CUT-03 Web importer scope is missing: workspace:\*/u);
});

test("an extra CUT-03 Web dependency authorization is rejected", () => {
  const drifted = document().replace(
    "and `@mish/domain`, each using exact `workspace:*`",
    "and `@mish/domain`, and `@mish/extra`, each using exact `workspace:*`",
  );
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(
    errors.join("\n"),
    /CUT-03 Web importer declares unauthorized dependencies: @mish\/extra/u,
  );
});

test("authorizing the root package manifest is rejected", () => {
  const drifted = document().replace("No root `package.json`", "Root `package.json`");
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(
    errors.join("\n"),
    /CUT-03 Web importer boundary is missing: No root `package\.json`/u,
  );
});

test("authorizing root or Web tsconfig files is rejected", () => {
  const drifted = document()
    .replace("root/apps Web tsconfig", "Web tsconfig")
    .replace("(`tsconfig.json` or `apps/web/tsconfig*.json`)", "(`tsconfig.json`)");
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(
    errors.join("\n"),
    /CUT-03 Web importer boundary is missing: root\/apps Web tsconfig/u,
  );
  assert.match(
    errors.join("\n"),
    /CUT-03 Web importer boundary is missing: `apps\/web\/tsconfig\*\.json`/u,
  );
});

test("authorizing another app or package manifest is rejected", () => {
  const drifted = document().replace(
    /or any other\s+app\/package manifest is authorized/u,
    "or another path is authorized",
  );
  const errors = validateTypescriptCutoverAdmission({ document: drifted });
  assert.match(
    errors.join("\n"),
    /CUT-03 Web importer boundary is missing: any other app\/package manifest is authorized/u,
  );
});
