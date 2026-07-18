import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent } from "react";

const INTERACTIVE_TARGETS = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[data-window-drag='exclude']",
].join(",");

interface DesktopWindowDependencies {
  isDesktop(): boolean;
  startDragging(): Promise<void>;
  toggleMaximize(): Promise<void>;
}

const defaultDependencies: DesktopWindowDependencies = {
  isDesktop: isTauri,
  startDragging: () => getCurrentWindow().startDragging(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
};

export function createDesktopWindowDragHandler(
  dependencies: DesktopWindowDependencies = defaultDependencies,
) {
  return function handleDesktopWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (
      !dependencies.isDesktop() ||
      event.button !== 0 ||
      event.defaultPrevented ||
      !(event.target instanceof Element) ||
      event.target.closest(INTERACTIVE_TARGETS)
    ) {
      return;
    }

    event.preventDefault();
    const action =
      event.detail === 2 ? dependencies.toggleMaximize() : dependencies.startDragging();
    void action.catch(() => undefined);
  };
}

export const handleDesktopWindowDrag = createDesktopWindowDragHandler();
