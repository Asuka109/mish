import { page, userEvent, cdp } from "vitest/browser";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toaster } from "sonner";
import type { DeliveredNotification } from "./notification-delivery";
import { dismissNotificationToast, presentNotificationToast } from "./sonner-notification-adapter";
import "../styles.css";

const longEnglishMessage =
  "Welcome to Mish. Your introduction remains available whenever you are ready to review the desktop setup and recovery controls.";
const longChineseMessage =
  "系统代理恢复失败，因为当前系统状态与 Mish 请求的配置不一致。请检查诊断信息，然后选择修复系统代理或保留当前设置。";
const activeNotificationIds = new Set<string>();

let root: Root;
let initialRuntime: string | undefined;

interface EmulationSession {
  send(
    method: "Emulation.setEmulatedMedia",
    params: { features: { name: string; value: string }[] },
  ): Promise<unknown>;
}

function Harness() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  return (
    <>
      <button onClick={() => setTheme(theme === "light" ? "dark" : "light")} type="button">
        Toggle theme
      </button>
      <Toaster closeButton expand position="bottom-right" theme={theme} />
    </>
  );
}

function notification(
  overrides: Partial<DeliveredNotification> & Pick<DeliveredNotification, "id" | "message">,
): DeliveredNotification {
  const { id, message, ...rest } = overrides;
  return {
    actions: [],
    id,
    level: "info",
    message,
    observedAt: Date.now(),
    read: false,
    removable: true,
    toast: "present",
    ...rest,
  };
}

function showNotification(
  value: DeliveredNotification,
  execute: (actionId?: string) => Promise<void> = async () => undefined,
) {
  activeNotificationIds.add(value.id);
  presentNotificationToast(value, execute);
}

function toastContaining(text: string): HTMLElement {
  const toast = [...document.querySelectorAll<HTMLElement>(".notification-toast")].find((element) =>
    element.textContent?.includes(text),
  );
  if (!toast) throw new Error(`Missing toast containing: ${text}`);
  return toast;
}

function expectInside(inner: DOMRect, outer: DOMRect) {
  expect(inner.left).toBeGreaterThanOrEqual(outer.left);
  expect(inner.right).toBeLessThanOrEqual(outer.right);
  expect(inner.top).toBeGreaterThanOrEqual(outer.top);
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom);
}

beforeAll(async () => {
  initialRuntime = document.documentElement.dataset.runtime;
  document.documentElement.dataset.runtime = "browser";
  const container = document.createElement("div");
  container.id = "sonner-notification-layout-root";
  document.body.append(container);
  root = createRoot(container);
  root.render(<Harness />);
  await vi.waitFor(() =>
    expect(document.querySelector("#sonner-notification-layout-root button")).not.toBeNull(),
  );
});

afterEach(async () => {
  for (const id of activeNotificationIds) dismissNotificationToast(id);
  activeNotificationIds.clear();
  await vi.waitFor(() => expect(document.querySelectorAll(".notification-toast")).toHaveLength(0));
  await page.viewport(1024, 768);
});

afterAll(() => {
  root.unmount();
  document.getElementById("sonner-notification-layout-root")?.remove();
  if (initialRuntime) document.documentElement.dataset.runtime = initialRuntime;
  else delete document.documentElement.dataset.runtime;
});

describe.sequential("Sonner notification layout", () => {
  test("keeps selectable no-action copy in one row with an accessible trailing close control", async () => {
    await page.viewport(960, 720);
    showNotification(notification({ id: "no-action", message: longChineseMessage }));

    const message = page.getByText(longChineseMessage, { exact: true });
    await expect.element(message).toBeVisible();
    const toast = toastContaining(longChineseMessage);
    const copy = toast.querySelector<HTMLElement>(".notification-toast-copy");
    const close = toast.querySelector<HTMLButtonElement>("[data-close-button]");
    if (!copy || !close) throw new Error("Missing no-action toast anatomy");

    expect(toast.querySelector(".notification-toast-actions")).toBeNull();
    expect(toast.getBoundingClientRect().bottom - copy.getBoundingClientRect().bottom).toBeLessThan(
      20,
    );
    expect(getComputedStyle(message.element()).userSelect).toBe("text");

    await userEvent.tripleClick(message);
    expect(document.getSelection()?.toString().trim()).toBe(longChineseMessage);

    close.focus();
    expect(document.activeElement).toBe(close);
    expect(close).toHaveAccessibleName("Close toast");
    expect(close.getBoundingClientRect().width).toBeGreaterThanOrEqual(28);
    expect(close.getBoundingClientRect().height).toBeGreaterThanOrEqual(28);
    expectInside(close.getBoundingClientRect(), toast.getBoundingClientRect());
    await userEvent.keyboard("{Enter}");
    await expect.element(message).not.toBeInTheDocument();
  });

  test("places one desktop action below long English copy without widening the button", async () => {
    await page.viewport(960, 720);
    const execute = vi.fn(async () => undefined);
    showNotification(
      notification({
        actions: [{ id: "open-welcome", label: "Open Welcome" }],
        id: "one-action",
        message: longEnglishMessage,
        title: "Your Mish welcome is ready",
      }),
      execute,
    );

    const action = page.getByRole("button", { exact: true, name: "Open Welcome" });
    await expect.element(action).toBeVisible();
    const toast = toastContaining(longEnglishMessage);
    expect(document.querySelector("[data-sonner-toaster]")).toHaveAttribute(
      "data-sonner-theme",
      "light",
    );
    const copy = toast.querySelector<HTMLElement>(".notification-toast-copy");
    const actions = toast.querySelector<HTMLElement>(".notification-toast-actions");
    const description = toast.querySelector<HTMLElement>("[data-description]");
    if (!copy || !actions || !description) throw new Error("Missing one-action toast anatomy");

    expect(actions.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      copy.getBoundingClientRect().bottom + 7,
    );
    expect(actions.getBoundingClientRect().left).toBeCloseTo(copy.getBoundingClientRect().left, 0);
    expect(action.element().getBoundingClientRect().width).toBeLessThan(
      actions.getBoundingClientRect().width,
    );
    expect(description.getBoundingClientRect().height).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(description).lineHeight) * 1.5,
    );
    expectInside(action.element().getBoundingClientRect(), toast.getBoundingClientRect());

    action.element().focus();
    expect(document.activeElement).toBe(action.element());
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith("open-welcome"));
  });

  test("stacks two ordered actions inside a narrow dark toast and preserves close clearance", async () => {
    await page.viewport(320, 640);
    await page.getByRole("button", { exact: true, name: "Toggle theme" }).click();
    showNotification(
      notification({
        actions: [
          { id: "repair", label: "修复系统代理" },
          { id: "leave-as-is", label: "保留当前设置", tone: "secondary" },
        ],
        id: "two-actions",
        level: "error",
        message: longChineseMessage,
        title: "无法恢复系统代理",
      }),
    );

    await expect
      .element(page.getByRole("button", { exact: true, name: "修复系统代理" }))
      .toBeVisible();
    expect(document.querySelector("[data-sonner-toaster]")).toHaveAttribute(
      "data-sonner-theme",
      "dark",
    );
    const toast = toastContaining(longChineseMessage);
    const toastRect = toast.getBoundingClientRect();
    const copy = toast.querySelector<HTMLElement>(".notification-toast-copy");
    const title = toast.querySelector<HTMLElement>("[data-title]");
    const actions = toast.querySelector<HTMLElement>(".notification-toast-actions");
    const close = toast.querySelector<HTMLElement>("[data-close-button]");
    const actionButtons = [
      ...toast.querySelectorAll<HTMLButtonElement>(".notification-toast-action"),
    ];
    if (!copy || !title || !actions || !close) throw new Error("Missing two-action toast anatomy");

    expect(actionButtons.map(({ textContent }) => textContent)).toEqual([
      "修复系统代理",
      "保留当前设置",
    ]);
    expect(getComputedStyle(actions).flexDirection).toBe("column");
    expect(actions.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      copy.getBoundingClientRect().bottom + 7,
    );
    expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(
      close.getBoundingClientRect().left,
    );
    for (const action of actionButtons) {
      expect(getComputedStyle(action).whiteSpace).toBe("nowrap");
      expect(action.getBoundingClientRect().width).toBeCloseTo(
        actions.getBoundingClientRect().width,
        0,
      );
      expectInside(action.getBoundingClientRect(), toastRect);
    }
    expect(actionButtons[0]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      actionButtons[1]!.getBoundingClientRect().top,
    );
  });

  test("keeps the bottom-right stack stable with reduced motion", async () => {
    const session = (await cdp()) as unknown as EmulationSession;
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    try {
      await page.viewport(800, 600);
      const viewportWidth = document.documentElement.clientWidth;
      showNotification(notification({ id: "reduced-motion-one", message: "Profile saved" }));
      showNotification(
        notification({
          actions: [{ id: "open-diagnostics", label: "Open Diagnostics" }],
          id: "reduced-motion-two",
          level: "error",
          message: longEnglishMessage,
          title: "Recovery failed",
        }),
      );

      await vi.waitFor(() =>
        expect(document.querySelectorAll(".notification-toast")).toHaveLength(2),
      );
      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      expect(document.documentElement.clientWidth).toBe(viewportWidth);
      const toasts = [...document.querySelectorAll<HTMLElement>(".notification-toast")];
      for (const toast of toasts) {
        expect(getComputedStyle(toast).transitionDuration).toBe("0s");
        const close = toast.querySelector<HTMLElement>("[data-close-button]");
        if (!close) throw new Error("Missing reduced-motion close control");
        expect(getComputedStyle(close).transitionDuration).toBe("0s");
      }
      const orderedRects = toasts
        .map((toast) => toast.getBoundingClientRect())
        .sort((left, right) => left.top - right.top);
      expect(orderedRects[0]!.bottom).toBeLessThanOrEqual(orderedRects[1]!.top);
      expect(
        document.querySelector(
          "[data-sonner-toaster][data-x-position='right'][data-y-position='bottom']",
        ),
      ).not.toBeNull();
    } finally {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });
});
