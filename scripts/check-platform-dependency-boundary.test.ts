import assert from "node:assert/strict";
import test from "node:test";
import { checkPlatformDependencyBoundary } from "./check-platform-dependency-boundary.ts";

test("macOS platform normal dependencies cannot reach the full Desktop Bridge", () => {
  assert.doesNotThrow(checkPlatformDependencyBoundary);
});
