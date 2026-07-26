import { TooltipProvider } from "@mish/ui";
import type { StatusConnectionState, StatusSnapshotDto } from "@mish/contracts";
import { page } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Toaster } from "sonner";
import { AppearanceProvider } from "../appearance";
import { NotificationBubble } from "../components/notification-bubble";
import {
  FixtureSettingsClient,
  createFixtureSettingsSnapshot,
} from "../data/fixture-settings-client";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { ProductProvider } from "../data/product-provider";
import { NotificationDeliveryProvider } from "../data/notification-delivery";
import { SettingsProvider } from "../data/settings-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { SettingsPage } from "../pages/settings-page";
import "../styles.css";

class BrowserSettingsStatusClient extends FixtureStatusClient {
  constructor(private readonly confirmedSnapshot: StatusSnapshotDto) {
    super();
  }

  override getConnectionState(): StatusConnectionState {
    return { attempt: 0, phase: "connected", stale: false };
  }

  override async getSnapshot() {
    return structuredClone(this.confirmedSnapshot);
  }

  override subscribeConnection(listener: (state: StatusConnectionState) => void) {
    listener(this.getConnectionState());
    return () => false;
  }

  override subscribeSnapshots(_listener: (snapshot: StatusSnapshotDto) => void) {
    return () => false;
  }
}

let client: BrowserSettingsStatusClient;
let root: Root;

beforeAll(async () => {
  await page.viewport(390, 844);
  loadAllLocales();
  document.body.innerHTML = '<div id="local-proxy-browser-root"></div>';

  const productSnapshot = await new FixtureStatusClient().getSnapshot();
  productSnapshot.adapterKind = "rpc";
  client = new BrowserSettingsStatusClient(productSnapshot);

  const settingsSnapshot = createFixtureSettingsSnapshot();
  settingsSnapshot.adapterKind = "rpc";
  settingsSnapshot.networkDns = {
    dns: null,
    failure: null,
    interfaces: [
      {
        interface: "en0",
        interfaceKind: "wifi",
        ipv4Available: true,
        ipv6Available: false,
        service: "Wi-Fi",
      },
    ],
    observedAt: null,
    phase: "unknown",
    source: null,
  };
  const settingsClient = new FixtureSettingsClient();
  const container = document.getElementById("local-proxy-browser-root");
  if (!container) throw new Error("Missing browser-test root");
  root = createRoot(container);
  root.render(
    <SettingsProvider client={settingsClient} initialSnapshot={settingsSnapshot}>
      <AppearanceProvider initialPreference="light" initialWindowSurfacePreference="opaque">
        <TypesafeI18n locale="zh">
          <MemoryRouter initialEntries={["/settings"]}>
            <ProductProvider client={client}>
              <NotificationDeliveryProvider>
                <TooltipProvider>
                  <NotificationBubble />
                  <SettingsPage />
                  <Toaster position="bottom-right" theme="light" />
                </TooltipProvider>
              </NotificationDeliveryProvider>
            </ProductProvider>
          </MemoryRouter>
        </TypesafeI18n>
      </AppearanceProvider>
    </SettingsProvider>,
  );

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("应用启动时");
  });
});

afterAll(() => root.unmount());

describe("narrow Settings layout", () => {
  test("preserves the control and section-description typography scale", () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "仅核心",
    );
    const description = document.querySelector<HTMLElement>("section h2 + p");
    if (!button || !description) throw new Error("Missing Settings typography evidence");

    expect(getComputedStyle(button).fontSize).toBe("13px");
    expect(getComputedStyle(description).fontSize).toBe("13px");
  });

  test("keeps the unavailable Chinese application launch row stable at a narrow width", async () => {
    const title = page.getByText("应用启动时", { exact: true });
    await expect.element(title).toBeVisible();
    const automaticRow = title.element().closest('[data-slot="settings-row"]');
    expect(automaticRow).toBeDefined();
    const off = [...automaticRow!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "关闭",
    );
    expect(off).toBeDefined();
    expect(off).toBeDisabled();
    expect(automaticRow!.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ).toBeLessThanOrEqual(1);
  });

  test("renders the merged proxy and startup settings in the requested order", () => {
    const section = document.querySelector<HTMLElement>(
      'section[aria-labelledby="settings-capture-startup"]',
    );
    const titles = [...(section?.querySelectorAll('[data-slot="settings-row"] strong') ?? [])].map(
      (title) => title.textContent?.trim(),
    );

    expect(titles).toEqual([
      "设备启动时",
      "应用启动时",
      "全局代理",
      "覆盖系统代理",
      "安装虚拟网卡",
      "识别连接进程",
      "代理端口",
      "Controller 端口",
    ]);
    expect(section?.textContent).not.toContain("单个应用代理");
    expect(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ).toBeLessThanOrEqual(1);
  });

  test("keeps concise address badges and version controls within the narrow Settings width", async () => {
    const ipv4 = document.querySelector<HTMLElement>('[aria-label="IPv4: 可用"]');
    const ipv6 = document.querySelector<HTMLElement>('[aria-label="IPv6: 不可用"]');
    expect(ipv4?.textContent).toBe("IPv4: 可用");
    expect(ipv6?.textContent).toBe("IPv6: 不可用");
    expect(ipv4?.getBoundingClientRect().width).toBeLessThan(80);
    expect(ipv6?.getBoundingClientRect().width).toBeLessThan(80);
    await expect.element(page.getByText("Mish 0.1.0", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Mihomo v1.19.29", { exact: true })).toBeVisible();
    const updates = page.getByRole("button", { exact: true, name: "检查更新" });
    await expect.element(updates).toBeDisabled();
    await expect.element(updates).toHaveAttribute("title", "即将支持");
  });
});
