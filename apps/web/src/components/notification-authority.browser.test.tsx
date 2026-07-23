import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Toaster } from "sonner";
import { AppearanceProvider } from "../appearance";
import {
  FixtureNotificationCenter,
  FixtureNotificationClient,
} from "../data/fixture-notification-client";
import { FixtureStatusClient } from "../data/fixture-status-client";
import {
  NotificationDeliveryProvider,
  notificationPublication,
} from "../data/notification-delivery";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import type { Locales } from "../i18n/i18n-types";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { NotificationBubble } from "./notification-bubble";
import "../styles.css";

let center: FixtureNotificationCenter;
let firstClient: FixtureNotificationClient;
let secondClient: FixtureNotificationClient;
let root: Root;
let statusClient: FixtureStatusClient;
let recoverSystemProxy: ReturnType<typeof vi.spyOn>;

class DriftStatusClient extends FixtureStatusClient {
  constructor(
    private readonly driftSnapshot: Awaited<ReturnType<FixtureStatusClient["getSnapshot"]>>,
  ) {
    super();
  }

  override async getSnapshot() {
    return structuredClone(this.driftSnapshot);
  }

  override subscribeSnapshots() {
    return () => false;
  }
}

function Harness({ client }: { client: FixtureNotificationClient }) {
  const [locale, setLocale] = useState<Locales>("en");
  return (
    <TypesafeI18n key={locale} locale={locale}>
      <AppearanceProvider initialPreference="light" initialWindowSurfacePreference="opaque">
        <MemoryRouter initialEntries={["/status"]}>
          <ProductProvider client={statusClient}>
            <NotificationDeliveryProvider client={client}>
              <TooltipProvider>
                <button onClick={() => setLocale("zh")} type="button">
                  中文
                </button>
                <NotificationBubble />
                <Toaster closeButton position="bottom-right" theme="light" />
              </TooltipProvider>
            </NotificationDeliveryProvider>
          </ProductProvider>
        </MemoryRouter>
      </AppearanceProvider>
    </TypesafeI18n>
  );
}

beforeAll(async () => {
  loadAllLocales();
  document.body.innerHTML = '<div id="notification-authority-root"></div>';
  center = new FixtureNotificationCenter();
  const bootstrapPublisher = new FixtureNotificationClient(center);
  await bootstrapPublisher.publish(
    notificationPublication("traffic.connections-closed", {
      dedupeKey: "traffic.connections-closed",
      params: { count: 2 },
      severity: "success",
    }),
  );
  bootstrapPublisher.dispose();
  firstClient = new FixtureNotificationClient(center);
  secondClient = new FixtureNotificationClient(center);
  const statusSnapshot = await new FixtureStatusClient().getSnapshot();
  statusSnapshot.adapterKind = "rpc";
  statusSnapshot.runtime.phase = "healthy";
  statusSnapshot.runtime.systemProxy = {
    desired: true,
    failure: null,
    observed: "other",
    phase: "drift",
    recoveryActions: ["repair", "leave-as-is"],
  };
  statusClient = new DriftStatusClient(statusSnapshot);
  recoverSystemProxy = vi.spyOn(statusClient, "recoverSystemProxy");
  const container = document.getElementById("notification-authority-root");
  if (!container) throw new Error("Missing notification authority browser root");
  root = createRoot(container);
  root.render(<Harness client={firstClient} />);
  await vi.waitFor(() =>
    expect(
      document
        .querySelector<HTMLButtonElement>(".notification-trigger")
        ?.getAttribute("aria-label"),
    ).toBe("Notifications, 1 unread"),
  );
});

afterAll(() => {
  root?.unmount();
  firstClient?.dispose();
  secondClient?.dispose();
});

describe("Rust-authoritative notification browser projection", () => {
  test("synchronizes toast, read, action, localization, instance removal, and reconnect lifecycle", async () => {
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0);

    await secondClient.publish(
      notificationPublication("system-proxy.drift", {
        dedupeKey: "system-proxy.drift",
        params: { canLeave: false, canRepair: true, repairRequiresCore: false },
        severity: "warning",
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1),
    );
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).toHaveAttribute("data-x-position", "right");
    expect(toaster).toHaveAttribute("data-y-position", "bottom");
    const closeToast = document.querySelector<HTMLButtonElement>(
      "[data-sonner-toast] [data-close-button]",
    );
    expect(closeToast).not.toBeNull();
    expect(getComputedStyle(closeToast!).opacity).toBe("0");
    expect(getComputedStyle(closeToast!).right).toBe("8px");
    const toastElement = closeToast!.closest<HTMLElement>("[data-sonner-toast]");
    if (!toastElement) throw new Error("Missing toast");
    await userEvent.hover(toastElement);
    await vi.waitFor(() => expect(getComputedStyle(closeToast!).opacity).toBe("1"));
    await closeToast!.click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0),
    );
    expect(
      (await firstClient.getSnapshot()).notifications.some(
        ({ dedupeKey }) => dedupeKey === "system-proxy.drift",
      ),
    ).toBe(true);

    const firstSnapshot = await firstClient.getSnapshot();
    const driftId = firstSnapshot.notifications.find(
      ({ dedupeKey }) => dedupeKey === "system-proxy.drift",
    )?.id;
    expect(driftId).toBeDefined();
    await secondClient.publish(
      notificationPublication("system-proxy.drift", {
        dedupeKey: "system-proxy.drift",
        params: { canLeave: true, canRepair: true, repairRequiresCore: false },
        severity: "warning",
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1),
    );
    expect(
      (await firstClient.getSnapshot()).notifications.find(
        ({ dedupeKey }) => dedupeKey === "system-proxy.drift",
      )?.id,
    ).toBe(driftId);

    await page.getByRole("button", { exact: true, name: "Notifications, 2 unread" }).click();
    await expect
      .element(page.getByRole("button", { exact: true, name: "Notifications, 0 unread" }))
      .toBeVisible();
    await vi.waitFor(async () =>
      expect((await secondClient.getSnapshot()).notifications.every(({ read }) => read)).toBe(true),
    );

    await page.getByRole("button", { exact: true, name: "中文" }).click();
    await page.getByRole("button", { name: /通知/ }).click();
    await expect
      .element(
        page.getByText(
          "macOS 当前的系统代理设置与 Mish 中的选择不一致。你可以修复，或保留系统当前设置。",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect.element(page.getByText("已关闭 2 条活动连接", { exact: true })).toBeVisible();

    await page
      .getByRole("dialog")
      .getByRole("button", { exact: true, name: "修复系统代理" })
      .click();
    await vi.waitFor(() =>
      expect(recoverSystemProxy).toHaveBeenCalledWith("repair", expect.any(Object)),
    );
    await secondClient.removeByDedupeKey("system-proxy.drift");

    const retainedMessage = page.getByText("已关闭 2 条活动连接", { exact: true });
    expect((await secondClient.getSnapshot()).notifications).toHaveLength(1);
    await page.getByRole("button", { exact: true, name: "移除通知：已关闭 2 条活动连接" }).click();
    await expect.element(retainedMessage).not.toBeInTheDocument();
    expect((await secondClient.getSnapshot()).notifications).toEqual([]);

    await secondClient.publish(
      notificationPublication("profile.activation-geosite-progress", {
        dedupeKey: "profile.activation-geodata:fixture:geo-site",
        params: { asset: "geo-site" },
        pinned: true,
        severity: "info",
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1),
    );
    await expect
      .element(
        page.getByRole("dialog").getByText("正在准备启用配置所需的 GeoSite…", { exact: true }),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByRole("button", {
          exact: true,
          name: "移除通知：正在准备启用配置所需的 GeoSite…",
        }),
      )
      .not.toBeInTheDocument();

    await secondClient.publish(
      notificationPublication("profile.activation-geosite-progress", {
        dedupeKey: "profile.activation-geodata:fixture:geo-site",
        params: { asset: "geo-site" },
        pinned: false,
        resolved: true,
        severity: "success",
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0),
    );
    const completedGeodata = page.getByText("GeoSite 已准备完成，可以启用配置。", {
      exact: true,
    });
    await expect.element(completedGeodata).toBeVisible();
    await page
      .getByRole("button", {
        exact: true,
        name: "移除通知：GeoSite 已准备完成，可以启用配置。",
      })
      .click();
    await expect.element(completedGeodata).not.toBeInTheDocument();

    firstClient.reconnect();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0),
    );
    await expect.element(page.getByText("暂无通知", { exact: true })).toBeVisible();
  });
});
