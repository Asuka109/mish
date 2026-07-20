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
  const button = document.querySelector<HTMLButtonElement>(
    '.local-proxy-control button[type="button"]',
  );
  const row = button?.closest(".settings-row");
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
              <TooltipProvider>
                <NotificationBubble />
                <SettingsPage />
                <Toaster position="bottom-right" theme="light" />
              </TooltipProvider>
            </ProductProvider>
          </MemoryRouter>
        </TypesafeI18n>
      </AppearanceProvider>
    </SettingsProvider>,
  );

  await vi.waitFor(() => {
    expect(document.querySelector('.local-proxy-control button[type="button"]')).not.toBeNull();
  });
});

afterAll(() => root.unmount());

describe("local proxy listener feedback", () => {
  test("keeps the Chinese Settings row stable at a narrow width", async () => {
    const button = page.getByRole("button", { exact: true, name: "测试监听器" });
    const before = measureLocalProxyGeometry();

    await button.click();
    await expect.element(button).toHaveAttribute("aria-busy", "true");
    expect(measureLocalProxyGeometry()).toEqual(before);

    client.complete();

    await expect.element(page.getByText("监听器就绪", { exact: true })).toBeVisible();
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster?.parentElement).toHaveAttribute("aria-live", "polite");
    await expect.element(button).not.toHaveAttribute("aria-busy");
    expect(measureLocalProxyGeometry()).toEqual(before);
    expect(document.querySelector(".local-proxy-result")).toBeNull();
    expect(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ).toBeLessThanOrEqual(1);
  });
});
