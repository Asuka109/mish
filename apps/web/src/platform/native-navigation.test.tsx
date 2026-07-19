import { describe, expect, it } from "vitest";
import { isNativeDestination } from "./native-navigation";

describe("native navigation", () => {
  it("accepts only fixed product destinations", () => {
    expect(isNativeDestination("/routes")).toBe(true);
    for (const destination of [
      "https://example.com",
      "file:///private/config.yaml",
      "/routes?token=secret",
      "/unknown",
    ]) {
      expect(isNativeDestination(destination)).toBe(false);
    }
  });
});
