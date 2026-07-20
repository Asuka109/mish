import { describe, expect, it } from "vitest";
import { resolveRuntimeKind } from "./runtime-kind";

describe("runtime selection", () => {
  it.each([
    [{ buildTarget: undefined, tauri: false }, "browser"],
    [{ buildTarget: "desktop", tauri: false }, "browser"],
    [{ buildTarget: "desktop", tauri: true }, "desktop"],
    [{ buildTarget: "mobile", tauri: true }, "mobile"],
  ] as const)("selects an explicit client for %o", (input, expected) => {
    expect(resolveRuntimeKind(input)).toBe(expected);
  });

  it("rejects a mobile bundle outside its native host", () => {
    expect(() => resolveRuntimeKind({ buildTarget: "mobile", tauri: false })).toThrow(
      "requires a Tauri host",
    );
  });
});
