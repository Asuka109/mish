import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import {
  FixtureNotificationCenter,
  FixtureNotificationClient,
} from "../data/fixture-notification-client";
import { FixtureStatusClient } from "../data/fixture-status-client";
import {
  NotificationDeliveryProvider,
  notificationPublication,
} from "../data/notification-delivery";
import { ProductProvider, useProduct } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import type { Locales } from "../i18n/i18n-types";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import type {
  SystemProxySettingsOpenOutcome,
  SystemProxySettingsOpener,
} from "../platform/system-proxy-settings";
import { NotificationBubble } from "./notification-bubble";
import "../styles.css";

class TakeoverRejectedStatusClient extends FixtureStatusClient {
  override async getSnapshot(options?: { signal?: AbortSignal }) {
    const snapshot = await super.getSnapshot(options);
    snapshot.adapterKind = "rpc";
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.captureSelection = { systemProxy: true, tun: false };
    snapshot.runtime.phase = "error";
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: "takeover-rejected",
      observed: "other",
      phase: "failed",
      recoveryActions: [],
    };
    snapshot.runtime.systemProxyEnabled = false;
    return snapshot;
  }

  override subscribeSnapshots() {
    return () => false;
  }
}

function CaptureStateProbe() {
  const { snapshot } = useProduct();
  return (
    <output aria-label="System Proxy retry state">
      {snapshot
        ? `${snapshot.runtime.systemProxy.phase}:${snapshot.runtime.captureSelection.systemProxy}`
        : "loading"}
    </output>
  );
}

let deliveryClient: FixtureNotificationClient | undefined;
let publisher: FixtureNotificationClient | undefined;
let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(loadAllLocales);

afterEach(() => {
  root?.unmount();
  deliveryClient?.dispose();
  publisher?.dispose();
  container?.remove();
  root = undefined;
  deliveryClient = undefined;
  publisher = undefined;
  container = undefined;
});

async function renderTakeoverRejection(
  locale: Locales,
  outcome: SystemProxySettingsOpenOutcome | Error,
) {
  const center = new FixtureNotificationCenter();
  deliveryClient = new FixtureNotificationClient(center);
  publisher = new FixtureNotificationClient(center);
  await publisher.publish(
    notificationPublication("capture.failure", {
      actionIds: ["open-system-proxy-settings", "show-system-proxy-settings-steps"],
      dedupeKey: "capture.failure",
      data: {
        failure: "takeover-rejected",
        takeoverReason: "protected-pac",
      },
      severity: "error",
    }),
  );
  const open = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const opener: SystemProxySettingsOpener = { open };
  container = document.createElement("div");
  container.id = "system-proxy-settings-action-root";
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <TypesafeI18n locale={locale}>
      <MemoryRouter initialEntries={["/status"]}>
        <ProductProvider client={new TakeoverRejectedStatusClient()}>
          <NotificationDeliveryProvider client={deliveryClient}>
            <TooltipProvider>
              <NotificationBubble systemProxySettingsOpener={opener} />
              <CaptureStateProbe />
            </TooltipProvider>
          </NotificationDeliveryProvider>
        </ProductProvider>
      </MemoryRouter>
    </TypesafeI18n>,
  );
  await vi.waitFor(() => {
    expect(document.querySelector(".notification-trigger")).not.toBeNull();
  });
  await userEvent.click(document.querySelector<HTMLButtonElement>(".notification-trigger")!);
  return { open };
}

describe("System Proxy takeover-rejection settings action", () => {
  test("keeps the rejection and explicit retry state after confirmed dispatch", async () => {
    const { open } = await renderTakeoverRejection("en", "opened");
    const action = page.getByRole("button", { exact: true, name: "Review Proxy Settings" });
    action.element().focus();
    await userEvent.keyboard("{Enter}");

    expect(open).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(action.element());
    await expect
      .element(page.getByText(/Mish left the existing System Proxy configuration unchanged/))
      .toBeVisible();
    await expect
      .element(page.getByLabelText("System Proxy retry state"))
      .toHaveTextContent("failed:true");
    expect(
      (await publisher!.getSnapshot()).notifications.some(
        ({ dedupeKey, resolved }) => dedupeKey === "capture.failure" && !resolved,
      ),
    ).toBe(true);
    expect(document.querySelector(".dialog-content")).toBeNull();
  });

  test("opens localized manual navigation in a focus-safe dialog when unsupported", async () => {
    await renderTakeoverRejection("en", "unsupported-version");
    const action = page.getByRole("button", { exact: true, name: "Review Proxy Settings" });
    action.element().focus();
    await userEvent.keyboard("{Enter}");

    await expect
      .element(page.getByRole("dialog", { name: "Open Proxy Settings Manually" }))
      .toBeVisible();
    const fallback = page.getByText("This macOS version can't open Network settings from Mish.", {
      exact: false,
    });
    await expect
      .element(fallback)
      .toHaveTextContent(
        "Open System Settings > Network, select the active network service, then choose Details > Proxies.",
      );
    const acknowledge = page.getByRole("button", { exact: true, name: "Got It" });
    expect(document.activeElement).toBe(acknowledge.element());
    await expect
      .element(page.getByLabelText("System Proxy retry state"))
      .toHaveTextContent("failed:true");

    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      document.querySelector<HTMLButtonElement>(".notification-trigger"),
    );
  });

  test("uses a Chinese manual dialog and never claims success after dispatch failure", async () => {
    await renderTakeoverRejection("zh", new Error("injected dispatch failure"));
    expect(
      [...document.querySelectorAll(".notification-actions button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["查看代理设置", "显示手动步骤"]);
    const action = page.getByRole("button", { exact: true, name: "查看代理设置" });
    await userEvent.click(action);

    await expect.element(page.getByRole("dialog", { name: "手动打开代理设置" })).toBeVisible();
    const fallback = page.getByText("Mish 无法打开“系统设置”", { exact: false });
    await expect.element(fallback).toHaveTextContent("Mish 无法打开“系统设置”");
    await expect.element(fallback).toHaveTextContent("检查外部配置后返回 Mish，并显式重试系统代理");
    expect(fallback.element().textContent).not.toContain("已打开");
  });

  test("opens the packaged-app manual fallback in a selectable modal dialog", async () => {
    await renderTakeoverRejection("en", "opened");
    const actions = [
      ...document.querySelectorAll<HTMLButtonElement>(".notification-actions button"),
    ];
    expect(actions.map(({ textContent }) => textContent)).toEqual([
      "Review Proxy Settings",
      "Show Manual Steps",
    ]);

    const manualAction = page.getByRole("button", { exact: true, name: "Show Manual Steps" });
    manualAction.element().focus();
    await userEvent.keyboard("{Enter}");

    await expect
      .element(page.getByRole("dialog", { name: "Open Proxy Settings Manually" }))
      .toBeVisible();
    const fallback = page.getByText(
      "Open System Settings > Network, select the active network service, then choose Details > Proxies.",
      { exact: false },
    );
    await expect.element(fallback).toBeVisible();
    expect(getComputedStyle(fallback.element()).userSelect).toBe("text");

    await userEvent.click(page.getByRole("button", { exact: true, name: "Got It" }));
    await userEvent.click(document.querySelector<HTMLButtonElement>(".notification-trigger")!);
    await expect
      .element(page.getByText(/Mish left the existing System Proxy configuration unchanged/))
      .toBeVisible();
  });
});
