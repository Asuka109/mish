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

interface Geometry {
  button: [number, number, number, number];
  buttonOpacity: string;
  row: [number, number, number, number];
}

function rectTuple(element: Element): [number, number, number, number] {
  const rect = element.getBoundingClientRect();
  return [rect.x, rect.y, rect.width, rect.height].map(
    (value) => Math.round(value * 100) / 100,
  ) as [number, number, number, number];
}

function measureLocalProxyGeometry(): Geometry {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button[type="button"]')].find(
    (candidate) => candidate.textContent?.trim() === "测试连接",
  );
  const row = button?.closest('[data-slot="settings-row"]');
  if (!button || !row) throw new Error("Missing local proxy Settings row");
  return {
    button: rectTuple(button),
    buttonOpacity: getComputedStyle(button).opacity,
    row: rectTuple(row),
  };
}

class BrowserLocalProxyClient extends FixtureStatusClient {
  private completeTest: (() => void) | null = null;

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

  readonly testLocalProxy = vi.fn(
    () =>
      new Promise<{ host: "127.0.0.1"; phase: "ready"; port: 7890 }>((resolve) => {
        this.completeTest = () => resolve({ host: "127.0.0.1", phase: "ready", port: 7890 });
      }),
  );

  complete() {
    this.completeTest?.();
  }
}

let client: BrowserLocalProxyClient;
let root: Root;

beforeAll(async () => {
  await page.viewport(390, 844);
  loadAllLocales();
  document.body.innerHTML = '<div id="local-proxy-browser-root"></div>';

  const productSnapshot = await new FixtureStatusClient().getSnapshot();
  productSnapshot.adapterKind = "rpc";
  client = new BrowserLocalProxyClient(productSnapshot);

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
    expect(
      [...document.querySelectorAll<HTMLButtonElement>('button[type="button"]')].some(
        (candidate) => candidate.textContent?.trim() === "测试连接",
      ),
    ).toBe(true);
  });
});

afterAll(() => root.unmount());

describe("local proxy listener feedback", () => {
  test("preserves the control and section-description typography scale", () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button[type="button"]')].find(
      (candidate) => candidate.textContent?.trim() === "测试连接",
    );
    const description = document.querySelector<HTMLElement>("section h2 + p");
    if (!button || !description) throw new Error("Missing Settings typography evidence");

    expect(getComputedStyle(button).fontSize).toBe("13px");
    expect(getComputedStyle(description).fontSize).toBe("13px");
  });

  test("keeps the unavailable Chinese automatic proxy launch row stable at a narrow width", async () => {
    const title = page.getByText("应用启动时自动代理", { exact: true });
    await expect.element(title).toBeVisible();
    const automaticRow = title.element().closest('[data-slot="settings-row"]');
    expect(automaticRow).toBeDefined();
    const off = page.getByRole("button", { exact: true, name: "应用启动时自动代理: 关闭" });
    await expect.element(off).toBeDisabled();
    expect(automaticRow!.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ).toBeLessThanOrEqual(1);
  });

  test("keeps the Chinese Settings row stable at a narrow width", async () => {
    const button = page.getByRole("button", { exact: true, name: "测试连接" });
    const before = measureLocalProxyGeometry();

    await button.click();
    await expect.element(button).toHaveAttribute("aria-busy", "true");
    expect(measureLocalProxyGeometry()).toEqual(before);

    client.complete();

    await expect.element(page.getByText("本地代理可用", { exact: true })).toBeVisible();
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster?.parentElement).toHaveAttribute("aria-live", "polite");
    await expect.element(button).not.toHaveAttribute("aria-busy");
    expect(measureLocalProxyGeometry()).toEqual(before);
    expect(document.querySelector(".local-proxy-result")).toBeNull();
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
