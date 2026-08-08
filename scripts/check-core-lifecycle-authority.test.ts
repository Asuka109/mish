import assert from "node:assert/strict";
import test from "node:test";
import { checkCoreLifecycleAuthority } from "./check-core-lifecycle-authority.ts";

test("repository keeps Core lifecycle mutations coordinator-only", () => {
  assert.doesNotThrow(checkCoreLifecycleAuthority);
});
