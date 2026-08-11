import assert from "node:assert/strict";
import test from "node:test";
import {
  readRepositorySource,
  validateRuntimeStateOwnership,
} from "./check-runtime-state-ownership.ts";

test("runtime ownership documentation and evidence are aligned", () => {
  assert.deepEqual(validateRuntimeStateOwnership(), []);
});

test("registry/documentation drift fails closed", () => {
  assert.match(
    validateRuntimeStateOwnership((relativePath) => {
      const source = readRepositorySource(relativePath);
      if (relativePath === "docs/architecture/runtime-state-ownership.md") {
        return source?.replace(
          "capture-owned-operation-lifecycle",
          "capture-owned-operation-drift",
        );
      }
      return source;
    }).join("\n"),
    /capture-owned-operation-lifecycle/u,
  );
});
