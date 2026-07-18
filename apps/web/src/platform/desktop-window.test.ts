import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { createDesktopWindowDragHandler } from "./desktop-window";

function createEvent(target: Element, detail = 1) {
  return {
    button: 0,
    defaultPrevented: false,
    detail,
    preventDefault: vi.fn(),
    target,
  } as unknown as ReactMouseEvent<HTMLElement>;
}

function createDependencies(isDesktop = true) {
  return {
    isDesktop: () => isDesktop,
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
    const event = createEvent(document.createElement("span"), 2);

    handler(event);

    expect(dependencies.startDragging).not.toHaveBeenCalled();
    expect(dependencies.toggleMaximize).toHaveBeenCalledOnce();
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
