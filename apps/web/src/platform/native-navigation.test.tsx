import { describe, expect, it } from "vitest";
import { isNativeDestination, isNativeSettingsShortcut } from "./native-navigation";

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

describe("native settings shortcut", () => {
  it("accepts the platform settings shortcuts without modifiers that change the command", () => {
    expect(
      isNativeSettingsShortcut(new KeyboardEvent("keydown", { key: ",", metaKey: true })),
    ).toBe(true);
    expect(
      isNativeSettingsShortcut(new KeyboardEvent("keydown", { key: ",", ctrlKey: true })),
    ).toBe(false);
    expect(
      isNativeSettingsShortcut(
        new KeyboardEvent("keydown", { key: ",", metaKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });
});
