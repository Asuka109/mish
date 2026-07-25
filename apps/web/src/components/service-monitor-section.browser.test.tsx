import { TooltipProvider } from "@mish/ui";
import type { StatusConnectionState, StatusSnapshotDto } from "@mish/contracts";
import { page } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { ProductProvider } from "../data/product-provider";
import { NotificationDeliveryProvider } from "../data/notification-delivery";
import { FixtureStatusClient } from "../data/fixture-status-client";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { ServiceIconImage, ServiceMonitorSection } from "./service-monitor-section";
import { SERVICE_ICON_URLS } from "@mish/contracts";
import "../styles.css";

class BrowserServiceMonitorClient extends FixtureStatusClient {
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

function semanticColor(token: "--color-error" | "--color-success-text" | "--color-warning") {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

let root: Root;

beforeAll(async () => {
  loadAllLocales();
  document.body.innerHTML = '<div id="service-monitor-browser-root"></div>';
  const snapshot = await new FixtureStatusClient().getSnapshot();
  const byId = (id: string) => {
    const result = snapshot.probeResults.find((candidate) => candidate.monitorId === id);
    if (!result) throw new Error(`Missing ${id} fixture result`);
    return result;
  };
  byId("google").latencyMilliseconds = 1000;
  byId("github").latencyMilliseconds = 1001;
  Object.assign(byId("cloudflare"), { latencyMilliseconds: 1001, status: "error" as const });
  snapshot.services = snapshot.services.slice(0, 5);

  const container = document.getElementById("service-monitor-browser-root");
  if (!container) throw new Error("Missing browser-test root");
  root = createRoot(container);
  root.render(
    <TypesafeI18n locale="en">
      <ProductProvider client={new BrowserServiceMonitorClient(snapshot)}>
        <NotificationDeliveryProvider>
          <TooltipProvider>
            <ServiceMonitorSection />
          </TooltipProvider>
        </NotificationDeliveryProvider>
      </ProductProvider>
    </TypesafeI18n>,
  );

  await vi.waitFor(() => {
    expect(document.querySelector(".service-monitor-latency")).not.toBeNull();
  });
});

afterAll(() => root.unmount());

describe("service monitor latency colors", () => {
  test("loads every built-in icon from the current origin with an accessible fixed-size image", () => {
    const icons = [
      ...document.querySelectorAll<HTMLImageElement>(
        ".service-monitor-row .service-monitor-icon img",
      ),
    ];

    expect(icons.map((icon) => icon.getAttribute("src"))).toEqual([
      SERVICE_ICON_URLS.google,
      SERVICE_ICON_URLS.github,
      SERVICE_ICON_URLS.cloudflare,
      SERVICE_ICON_URLS.baidu,
      SERVICE_ICON_URLS.weixin,
    ]);
    for (const icon of icons) {
      const relativeSource = icon.getAttribute("src");
      expect(relativeSource).not.toBeNull();
      expect(new URL(relativeSource ?? "", "http://127.0.0.1:6474/status").origin).toBe(
        "http://127.0.0.1:6474",
      );
      expect(new URL(relativeSource ?? "", "http://127.0.0.1:6475/status").origin).toBe(
        "http://127.0.0.1:6475",
      );
      expect(icon).toHaveAttribute("alt", "");
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveAttribute("data-monochrome", "true");
      expect(icon.parentElement?.className).toContain("size-5.5");
    }
  });

  test("never assigns an unsafe source and swaps a failed HTTPS image in place", async () => {
    const fallbackHost = document.createElement("div");
    document.body.append(fallbackHost);
    const fallbackRoot = createRoot(fallbackHost);

    fallbackRoot.render(<ServiceIconImage src="javascript:alert(1)" />);
    await vi.waitFor(() => {
      expect(fallbackHost.querySelector("img")).not.toBeNull();
    });
    const unsafeImage = fallbackHost.querySelector<HTMLImageElement>("img");
    expect(unsafeImage?.getAttribute("src")).toBe(SERVICE_ICON_URLS.fallback);
    expect(unsafeImage).toHaveAttribute("data-service-icon-fallback", "true");

    const remoteSource = "https://icons.invalid/missing.svg";
    fallbackRoot.render(<ServiceIconImage src={remoteSource} />);
    await vi.waitFor(() => {
      expect(fallbackHost.querySelector("img")?.getAttribute("src")).toBe(
        SERVICE_ICON_URLS.fallback,
      );
    });
    expect(fallbackHost.querySelector("img")).toHaveAttribute("data-service-icon-fallback", "true");
    expect(fallbackHost.querySelector("img")?.parentElement?.className).not.toContain("hidden");

    fallbackRoot.unmount();
    fallbackHost.remove();
  });

  test("declares one, three, and four-column breakpoints with complete final rows", () => {
    const list = document.querySelector<HTMLElement>(".service-monitor-list");
    if (!list) throw new Error("Missing service monitor list");

    expect(list.style.getPropertyValue("--section-grid-columns")).toBe("");
    expect(list.className).toContain("[--section-grid-columns:3]");
    expect(list.className).toContain("service-grid-wide:[--section-grid-columns:4]");
    expect(list.className).toContain("max-page-compact:[--section-grid-columns:1]");
    expect(list.querySelectorAll(".service-monitor-row")).toHaveLength(5);
    expect(
      list.querySelectorAll('.service-monitor-placeholder-medium[aria-hidden="true"]'),
    ).toHaveLength(1);
    expect(
      list.querySelectorAll('.service-monitor-placeholder-wide[aria-hidden="true"]'),
    ).toHaveLength(3);
  });

  test("uses success at 1000ms, warning above it, and error before slow latency", async () => {
    const google = page.getByRole("button", { name: "Test Latency for Google" });
    const github = page.getByRole("button", { name: "Test Latency for GitHub" });
    const cloudflare = page.getByRole("button", { name: "Test Latency for Cloudflare" });

    await expect.element(google.getByText("1000 ms")).toBeVisible();
    await expect.element(github.getByText("1001 ms")).toBeVisible();
    await expect.element(cloudflare.getByText("Unreachable")).toBeVisible();

    const googleLatency = document.querySelector<HTMLElement>(
      '[aria-label="Test Latency for Google"] .service-monitor-latency',
    );
    const githubLatency = document.querySelector<HTMLElement>(
      '[aria-label="Test Latency for GitHub"] .service-monitor-latency',
    );
    const cloudflareLatency = document.querySelector<HTMLElement>(
      '[aria-label="Test Latency for Cloudflare"] .service-monitor-latency',
    );
    if (!googleLatency || !githubLatency || !cloudflareLatency) {
      throw new Error("Missing service latency elements");
    }

    expect(getComputedStyle(googleLatency).color).toBe(semanticColor("--color-success-text"));
    expect(getComputedStyle(githubLatency).color).toBe(semanticColor("--color-warning"));
    expect(getComputedStyle(cloudflareLatency).color).toBe(semanticColor("--color-error"));
  });
});
