import { readFileSync } from "node:fs";
import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  isNativeDestination,
  isNativeSettingsShortcut,
  NativeNavigationBridge,
} from "./native-navigation";

const mainCapability = JSON.parse(
  readFileSync("../desktop/src-tauri/capabilities/main.json", "utf8"),
) as {
  local: boolean;
  permissions: string[];
  windows: string[];
};

function createListenerDependencies() {
  const navigationHandlers = new Set<(destination: string) => void>();
  const focusSearchHandlers = new Set<() => void>();
  const navigationCleanup = vi.fn();
  const focusSearchCleanup = vi.fn();

  return {
    dependencies: {
      isDesktop: () => true,
      listenForFocusSearch: vi.fn(async (handler: () => void) => {
        focusSearchHandlers.add(handler);
        return () => {
          focusSearchCleanup();
          focusSearchHandlers.delete(handler);
        };
      }),
      listenForNavigation: vi.fn(async (handler: (destination: string) => void) => {
        navigationHandlers.add(handler);
        return () => {
          navigationCleanup();
          navigationHandlers.delete(handler);
        };
      }),
    },
    focusSearchCleanup,
    focusSearchHandlers,
    navigationCleanup,
    navigationHandlers,
  };
}

describe("native navigation", () => {
  it("grants the trusted main WebView only the paired event listener permissions", () => {
    expect(mainCapability.local).toBe(true);
    expect(mainCapability.windows).toEqual(["main"]);
    expect(
      mainCapability.permissions.filter((permission) => permission.startsWith("core:event:")),
    ).toEqual(["core:event:allow-listen", "core:event:allow-unlisten"]);
  });

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

  it("keeps one active native subscription through navigation, unmount, and remount", async () => {
    const listeners = createListenerDependencies();
    const renderBridge = () =>
      render(
        <MemoryRouter>
          <NativeNavigationBridge dependencies={listeners.dependencies} />
        </MemoryRouter>,
      );

    const first = renderBridge();
    await waitFor(() => {
      expect(listeners.navigationHandlers.size).toBe(1);
      expect(listeners.focusSearchHandlers.size).toBe(1);
    });

    act(() => {
      for (const destination of [
        "/status",
        "/profiles",
        "/traffic",
        "/events",
        "/settings",
        "/status",
      ]) {
        for (const handler of listeners.navigationHandlers) handler(destination);
      }
    });
    expect(listeners.navigationHandlers.size).toBe(1);
    expect(listeners.focusSearchHandlers.size).toBe(1);

    first.unmount();
    await waitFor(() => {
      expect(listeners.navigationHandlers.size).toBe(0);
      expect(listeners.focusSearchHandlers.size).toBe(0);
    });

    const second = renderBridge();
    await waitFor(() => {
      expect(listeners.navigationHandlers.size).toBe(1);
      expect(listeners.focusSearchHandlers.size).toBe(1);
    });

    second.unmount();
    await waitFor(() => {
      expect(listeners.navigationHandlers.size).toBe(0);
      expect(listeners.focusSearchHandlers.size).toBe(0);
      expect(listeners.navigationCleanup).toHaveBeenCalledTimes(
        listeners.dependencies.listenForNavigation.mock.calls.length,
      );
      expect(listeners.focusSearchCleanup).toHaveBeenCalledTimes(
        listeners.dependencies.listenForFocusSearch.mock.calls.length,
      );
    });
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
