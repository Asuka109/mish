import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyMacOsPrivilegedBundle } from "./macos-privileged-bundle.ts";

function applicationFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "mish-alpha-ad-hoc-"));
  const application = path.join(root, "Mish.app");
  mkdirSync(path.join(application, "Contents", "Resources"), { recursive: true });
  return application;
}

test("alpha-ad-hoc rejects SMAppService and development helper payloads", async () => {
  const application = applicationFixture();
  const xpc = path.join(application, "Contents", "XPCServices", "Mish.xpc");
  mkdirSync(xpc, { recursive: true });
  await assert.rejects(verifyMacOsPrivilegedBundle(application, "ad-hoc"), /privileged artifacts/u);
});

test("alpha-ad-hoc rejects linked privileged directories", async () => {
  const application = applicationFixture();
  const outside = path.join(path.dirname(application), "outside");
  mkdirSync(outside);
  symlinkSync(outside, path.join(application, "Contents", "Library"));
  await assert.rejects(verifyMacOsPrivilegedBundle(application, "ad-hoc"), /privileged artifacts/u);
});
