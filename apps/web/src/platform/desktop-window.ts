import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, type Theme } from "@tauri-apps/api/window";
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
  "[data-base-ui-portal]",
  "[data-window-drag='exclude']",
].join(",");

interface DesktopWindowDependencies {
  isDesktop(): boolean;
  revealMainWindow(): Promise<void>;
  setTheme(theme: Theme | null): Promise<void>;
  startDragging(): Promise<void>;
  toggleMaximize(): Promise<void>;
}

interface DesktopWindowDragOptions {
  maximizeOnDoubleClick?: boolean;
}

const defaultDependencies: DesktopWindowDependencies = {
  isDesktop: isTauri,
  revealMainWindow: () => invoke("reveal_main_window"),
  setTheme: (theme) => getCurrentWindow().setTheme(theme),
  startDragging: () => getCurrentWindow().startDragging(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
};

export function createDesktopWindowDragHandler(
  dependencies: DesktopWindowDependencies = defaultDependencies,
  { maximizeOnDoubleClick = true }: DesktopWindowDragOptions = {},
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
      maximizeOnDoubleClick && event.detail === 2
        ? dependencies.toggleMaximize()
        : dependencies.startDragging();
    void action.catch(() => undefined);
  };
}

export const handleDesktopWindowDrag = createDesktopWindowDragHandler();
export const handleDesktopWindowDragOnly = createDesktopWindowDragHandler(defaultDependencies, {
  maximizeOnDoubleClick: false,
});

export function createDesktopWindowAppearanceSync(
  dependencies: Pick<DesktopWindowDependencies, "isDesktop" | "setTheme"> = defaultDependencies,
) {
  return function syncDesktopWindowAppearance(preference: Theme | "system") {
    if (!dependencies.isDesktop()) return;

    const theme = preference === "system" ? null : preference;
    void dependencies.setTheme(theme).catch(() => undefined);
  };
}

export const syncDesktopWindowAppearance = createDesktopWindowAppearanceSync();

export function createDesktopWindowReadySignal(
  dependencies: Pick<
    DesktopWindowDependencies,
    "isDesktop" | "revealMainWindow"
  > = defaultDependencies,
) {
  return async function signalDesktopWindowReady() {
    if (!dependencies.isDesktop()) return;
    await dependencies.revealMainWindow();
  };
}

export const signalDesktopWindowReady = createDesktopWindowReadySignal();
