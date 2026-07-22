import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createDesktopWindowAppearanceSync,
  createDesktopWindowDragHandler,
  createDesktopWindowReadySignal,
} from "./desktop-window";

function createEvent(target: Element, { button = 0, defaultPrevented = false, detail = 1 } = {}) {
  return {
    button,
    defaultPrevented,
    detail,
    preventDefault: vi.fn(),
    target,
  } as unknown as ReactMouseEvent<HTMLElement>;
}

function createDependencies(isDesktop = true) {
  return {
    isDesktop: () => isDesktop,
    revealMainWindow: vi.fn().mockResolvedValue(undefined),
    setTheme: vi.fn().mockResolvedValue(undefined),
    startDragging: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
  };
}

describe("desktop window drag routing", () => {
  it("starts native dragging from a non-interactive part of the top surface", () => {
    const dependencies = createDependencies();
    const handler = createDesktopWindowDragHandler(dependencies);
    const title = document.createElement("span");
    const event = createEvent(title);

    handler(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(dependencies.startDragging).toHaveBeenCalledOnce();
    expect(dependencies.toggleMaximize).not.toHaveBeenCalled();
  });

  it("lets interactive descendants receive their ordinary pointer behavior", () => {
    const dependencies = createDependencies();
    const handler = createDesktopWindowDragHandler(dependencies);
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.append(icon);
    const event = createEvent(icon);

    handler(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(dependencies.startDragging).not.toHaveBeenCalled();
    expect(dependencies.toggleMaximize).not.toHaveBeenCalled();
  });

  it("uses native title-bar zoom behavior for a desktop double click", () => {
    const dependencies = createDependencies();
    const handler = createDesktopWindowDragHandler(dependencies);
    const event = createEvent(document.createElement("span"), { detail: 2 });

    handler(event);

    expect(dependencies.startDragging).not.toHaveBeenCalled();
    expect(dependencies.toggleMaximize).toHaveBeenCalledOnce();
  });

  it("keeps a drag-only surface from toggling native zoom on double click", () => {
    const dependencies = createDependencies();
    const handler = createDesktopWindowDragHandler(dependencies, {
      maximizeOnDoubleClick: false,
    });

    handler(createEvent(document.createElement("span"), { detail: 2 }));

    expect(dependencies.startDragging).toHaveBeenCalledOnce();
    expect(dependencies.toggleMaximize).not.toHaveBeenCalled();
  });

  it("does not route non-primary or already-prevented presses to the native window", () => {
    const dependencies = createDependencies();
    const handler = createDesktopWindowDragHandler(dependencies);
    const target = document.createElement("span");

    handler(createEvent(target, { button: 1 }));
    handler(createEvent(target, { defaultPrevented: true }));

    expect(dependencies.startDragging).not.toHaveBeenCalled();
    expect(dependencies.toggleMaximize).not.toHaveBeenCalled();
  });

  it("does not intercept the same surfaces in an ordinary browser", () => {
    const dependencies = createDependencies(false);
    const handler = createDesktopWindowDragHandler(dependencies);
    const event = createEvent(document.createElement("span"));

    handler(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(dependencies.startDragging).not.toHaveBeenCalled();
  });
});

describe("desktop window appearance", () => {
  it("keeps native material aligned with explicit light and dark appearances", () => {
    const dependencies = createDependencies();
    const syncAppearance = createDesktopWindowAppearanceSync(dependencies);

    syncAppearance("light");
    syncAppearance("dark");

    expect(dependencies.setTheme).toHaveBeenNthCalledWith(1, "light");
    expect(dependencies.setTheme).toHaveBeenNthCalledWith(2, "dark");
  });

  it("lets the native window follow macOS when the preference is system", () => {
    const dependencies = createDependencies();
    const syncAppearance = createDesktopWindowAppearanceSync(dependencies);

    syncAppearance("system");

    expect(dependencies.setTheme).toHaveBeenCalledWith(null);
  });

  it("does not invoke native window APIs in a browser", () => {
    const dependencies = createDependencies(false);
    const syncAppearance = createDesktopWindowAppearanceSync(dependencies);

    syncAppearance("dark");

    expect(dependencies.setTheme).not.toHaveBeenCalled();
  });
});

describe("desktop first-frame reveal", () => {
  it("reveals the native window only after the desktop frontend is ready", async () => {
    const dependencies = createDependencies();
    const signalReady = createDesktopWindowReadySignal(dependencies);

    await signalReady();

    expect(dependencies.revealMainWindow).toHaveBeenCalledOnce();
  });

  it("does not invoke the reveal command in an ordinary browser", async () => {
    const dependencies = createDependencies(false);
    const signalReady = createDesktopWindowReadySignal(dependencies);

    await signalReady();

    expect(dependencies.revealMainWindow).not.toHaveBeenCalled();
  });
});
