import {
  Dialog,
  DialogContent,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { Toaster, toast } from "sonner";
import { AppearanceProvider } from "../appearance";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { createDesktopWindowDragHandler } from "../platform/desktop-window";
import { StartupFailure } from "./startup-failure";
import { DesktopWindowFrame } from "./desktop-window-frame";
import "../styles.css";

function elementAtTopCenter() {
  return document.elementFromPoint(window.innerWidth / 2, 5);
}

let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
  await page.viewport(1024, 768);
  loadAllLocales();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterAll(() => {
  root.unmount();
  container.remove();
});

describe("desktop window frame overlay boundaries", () => {
  test("keeps the top frame strip above a dialog backdrop, dialog, and notification", async () => {
    const dialogAction = vi.fn();
    root.render(
      <DesktopWindowFrame runtime="desktop">
        <Dialog defaultOpen>
          <DialogContent aria-describedby={undefined} showCloseButton={false}>
            <DialogTitle>Overlay title</DialogTitle>
            <button onClick={dialogAction} type="button">
              Dialog action
            </button>
          </DialogContent>
        </Dialog>
        <Toaster position="bottom-right" />
      </DesktopWindowFrame>,
    );
    await vi.waitFor(() => {
      expect(document.querySelector(".dialog-backdrop")).not.toBeNull();
    });
    toast("Notification overlay");
    await vi.waitFor(() => {
      expect(document.querySelector("[data-sonner-toaster]")).not.toBeNull();
    });

    const frame = document.querySelector<HTMLElement>('[data-window-drag-surface="window-frame"]');
    const backdrop = document.querySelector<HTMLElement>(".dialog-backdrop");
    if (!frame || !backdrop) throw new Error("Missing desktop frame or dialog backdrop");

    expect(frame.getBoundingClientRect().toJSON()).toMatchObject({
      height: 34,
      top: 0,
      width: 1024,
    });
    expect(getComputedStyle(frame).zIndex).toBe("1000000000");
    expect(Number(getComputedStyle(frame).zIndex)).toBeGreaterThan(
      Number(getComputedStyle(backdrop).zIndex),
    );
    expect(elementAtTopCenter()).toBe(frame);

    await userEvent.click(page.getByRole("button", { name: "Dialog action" }));
    expect(dialogAction).toHaveBeenCalledOnce();
  });

  test("keeps the same frame strip while the startup failure owns the viewport", async () => {
    root.render(
      <DesktopWindowFrame runtime="desktop">
        <AppearanceProvider>
          <TypesafeI18n locale="en">
            <StartupFailure />
          </TypesafeI18n>
        </AppearanceProvider>
      </DesktopWindowFrame>,
    );

    await expect.element(page.getByRole("alert")).toBeVisible();
    const frame = document.querySelector<HTMLElement>('[data-window-drag-surface="window-frame"]');
    const failure = document.querySelector<HTMLElement>(".startup-failure");
    if (!frame || !failure) throw new Error("Missing desktop frame or startup failure");

    expect(elementAtTopCenter()).toBe(frame);
    expect(document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)).not.toBe(
      frame,
    );
    expect(getComputedStyle(failure).position).toBe("fixed");
  });

  test("marks portal overlay surfaces as excluded from the desktop drag contract", async () => {
    root.render(
      <DesktopWindowFrame runtime="desktop">
        <Dialog defaultOpen>
          <DialogContent aria-describedby={undefined} showCloseButton={false}>
            <DialogTitle>Dialog overlay</DialogTitle>
          </DialogContent>
        </Dialog>
        <Popover defaultOpen>
          <PopoverTrigger>Notifications</PopoverTrigger>
          <PopoverContent>
            <p>Notification center content</p>
          </PopoverContent>
        </Popover>
      </DesktopWindowFrame>,
    );

    await expect.element(page.getByText("Notification center content")).toBeVisible();
    const notificationContent = document
      .querySelector<HTMLElement>(".popover-content")
      ?.closest<HTMLElement>("[data-window-drag='exclude']");
    const dialogContent = document.querySelector<HTMLElement>(".dialog-content");
    const backdrop = document.querySelector<HTMLElement>(".dialog-backdrop");
    if (!notificationContent || !dialogContent || !backdrop) {
      throw new Error("Missing portal overlay surface");
    }

    expect(notificationContent).toHaveAttribute("data-window-drag", "exclude");
    expect(dialogContent).toHaveAttribute("data-window-drag", "exclude");
    expect(backdrop).toHaveAttribute("data-window-drag", "exclude");
  });

  test("does not route notification popover content into native drag or zoom", async () => {
    const nativeWindow = {
      isDesktop: () => true,
      revealMainWindow: vi.fn().mockResolvedValue(undefined),
      setTheme: vi.fn().mockResolvedValue(undefined),
      startDragging: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
    };
    const routeWindowDrag = createDesktopWindowDragHandler(nativeWindow);

    root.render(
      <div onMouseDown={routeWindowDrag}>
        <DesktopWindowFrame runtime="desktop">
          <Popover defaultOpen>
            <PopoverTrigger>Notifications</PopoverTrigger>
            <PopoverContent>
              <p>Notification center content</p>
            </PopoverContent>
          </Popover>
        </DesktopWindowFrame>
      </div>,
    );

    const content = page.getByText("Notification center content");
    await expect.element(content).toBeVisible();
    await userEvent.dblClick(content);

    expect(nativeWindow.startDragging).not.toHaveBeenCalled();
    expect(nativeWindow.toggleMaximize).not.toHaveBeenCalled();
  });

  test("does not route dialog content into native drag or zoom", async () => {
    const nativeWindow = {
      isDesktop: () => true,
      revealMainWindow: vi.fn().mockResolvedValue(undefined),
      setTheme: vi.fn().mockResolvedValue(undefined),
      startDragging: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
    };
    const routeWindowDrag = createDesktopWindowDragHandler(nativeWindow);

    root.render(
      <div onMouseDown={routeWindowDrag}>
        <DesktopWindowFrame runtime="desktop">
          <Dialog defaultOpen>
            <DialogContent aria-describedby={undefined} showCloseButton={false}>
              <DialogTitle>Dialog overlay</DialogTitle>
            </DialogContent>
          </Dialog>
        </DesktopWindowFrame>
      </div>,
    );

    const content = page.getByText("Dialog overlay");
    await expect.element(content).toBeVisible();
    await userEvent.dblClick(content);

    expect(nativeWindow.startDragging).not.toHaveBeenCalled();
    expect(nativeWindow.toggleMaximize).not.toHaveBeenCalled();
  });
});
