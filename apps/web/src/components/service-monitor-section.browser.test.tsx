import { TooltipProvider } from "@mish/ui";
import type { StatusConnectionState, StatusSnapshotDto } from "@mish/contracts";
import { page } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { ProductProvider } from "../data/product-provider";
import { FixtureStatusClient } from "../data/fixture-status-client";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { ServiceMonitorSection } from "./service-monitor-section";
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

  const container = document.getElementById("service-monitor-browser-root");
  if (!container) throw new Error("Missing browser-test root");
  root = createRoot(container);
  root.render(
    <TypesafeI18n locale="en">
      <ProductProvider client={new BrowserServiceMonitorClient(snapshot)}>
        <TooltipProvider>
          <ServiceMonitorSection />
        </TooltipProvider>
      </ProductProvider>
    </TypesafeI18n>,
  );

  await vi.waitFor(() => {
    expect(document.querySelector(".service-monitor-latency")).not.toBeNull();
  });
});

afterAll(() => root.unmount());

describe("service monitor latency colors", () => {
  test("uses success at 1000ms, warning above it, and error before slow latency", async () => {
    const google = page.getByRole("button", { name: "Test latency for Google" });
    const github = page.getByRole("button", { name: "Test latency for GitHub" });
    const cloudflare = page.getByRole("button", { name: "Test latency for Cloudflare" });

    await expect.element(google.getByText("1000 ms")).toBeVisible();
    await expect.element(github.getByText("1001 ms")).toBeVisible();
    await expect.element(cloudflare.getByText("Unreachable")).toBeVisible();

    const googleLatency = document.querySelector<HTMLElement>(
      '[aria-label="Test latency for Google"] .service-monitor-latency',
    );
    const githubLatency = document.querySelector<HTMLElement>(
      '[aria-label="Test latency for GitHub"] .service-monitor-latency',
    );
    const cloudflareLatency = document.querySelector<HTMLElement>(
      '[aria-label="Test latency for Cloudflare"] .service-monitor-latency',
    );
    if (!googleLatency || !githubLatency || !cloudflareLatency) {
      throw new Error("Missing service latency elements");
    }

    expect(getComputedStyle(googleLatency).color).toBe(semanticColor("--color-success-text"));
    expect(getComputedStyle(githubLatency).color).toBe(semanticColor("--color-warning"));
    expect(getComputedStyle(cloudflareLatency).color).toBe(semanticColor("--color-error"));
  });
});
