import { describe, expect, it } from "vitest";
import { resolveRuntimeKind } from "./runtime-kind";

describe("runtime selection", () => {
  it.each([
    [{ buildMode: "production", tauri: false }, "browser"],
    [{ buildMode: "production", tauri: true }, "desktop"],
    [{ buildMode: "mobile", tauri: true }, "mobile"],
  ] as const)("selects an explicit client for %o", (input, expected) => {
    expect(resolveRuntimeKind(input)).toBe(expected);
  });

  it("rejects a mobile bundle outside its native host", () => {
    expect(() => resolveRuntimeKind({ buildMode: "mobile", tauri: false })).toThrow(
      "requires a Tauri host",
    );
  });
});
