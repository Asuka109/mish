import type { StatusConnectionState } from "@mish/contracts";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import {
  discoverMishBrowserBackend,
  MISH_BROWSER_DISCOVERY_PROTOCOL_VERSION,
  MISH_BROWSER_DISCOVERY_SCHEMA_VERSION,
  MISH_BROWSER_DISCOVERY_SERVICE,
  probeMishBrowserBackend,
} from "../platform/browser-backend-discovery";
import { installFocusVisibility } from "../platform/focus-visibility";
import { BrowserBackendRecovery } from "./browser-backend-recovery";
import "../styles.css";

class ConnectionMonitor {
  private listeners = new Set<(state: StatusConnectionState) => void>();
  private state: StatusConnectionState = { attempt: 0, phase: "connected", stale: false };

  disconnect() {
    this.state = { attempt: 5, phase: "disconnected", stale: true };
    for (const listener of this.listeners) listener(this.state);
  }

  getConnectionState() {
    return this.state;
  }

  subscribeConnection(listener: (state: StatusConnectionState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
}

const marker = {
  protocolVersion: MISH_BROWSER_DISCOVERY_PROTOCOL_VERSION,
  schemaVersion: MISH_BROWSER_DISCOVERY_SCHEMA_VERSION,
  service: MISH_BROWSER_DISCOVERY_SERVICE,
};

let root: Root;
let disposeFocusVisibility: () => void;
const monitor = new ConnectionMonitor();
const visited: number[] = [];
const navigate = vi.fn(() => new Promise<void>(() => undefined));

beforeAll(async () => {
  loadAllLocales();
  disposeFocusVisibility = installFocusVisibility();
  document.body.innerHTML = '<div id="browser-backend-recovery-root"></div>';
  const container = document.getElementById("browser-backend-recovery-root");
  if (!container) throw new Error("Missing browser recovery test root");

  const fetchRequest = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const port = Number.parseInt(new URL(String(input)).port, 10);
    if (init?.mode !== "no-cors") visited.push(port);
    if (port === 5000) throw new TypeError("connection refused");
    if (port === 6474) {
      if (init?.mode === "no-cors") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ service: "another-listener" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (port === 6475) throw new TypeError("connection refused");
    return new Response(JSON.stringify(marker), {
      headers: { "Content-Type": "application/json" },
    });
  });

  root = createRoot(container);
  root.render(
    <TypesafeI18n locale="en">
      <BrowserBackendRecovery
        backendPort={5000}
        connection={monitor}
        discover={(options) =>
          discoverMishBrowserBackend({
            ...options,
            fetch: fetchRequest,
            maxPort: 6476,
          })
        }
        navigate={navigate}
        probe={(options) => probeMishBrowserBackend({ ...options, fetch: fetchRequest })}
        runtime="browser"
      >
        <span>Connected application</span>
      </BrowserBackendRecovery>
    </TypesafeI18n>,
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Connected application"));
  monitor.disconnect();
  await vi.waitFor(() =>
    expect(document.querySelector(".browser-backend-recovery")).not.toBeNull(),
  );
});

afterAll(() => {
  disposeFocusVisibility();
  root.unmount();
});

describe("browser backend recovery in Chromium", () => {
  test("keeps reconnect announcement focus visually silent", () => {
    const heading = document.querySelector<HTMLElement>("#browser-backend-recovery-title");
    if (!heading) throw new Error("Missing recovery heading");

    expect(document.activeElement).toBe(heading);
    expect(heading).not.toHaveAttribute("data-mish-focus-visible");
    expect(getComputedStyle(heading).outlineStyle).toBe("none");
  });

  test("keeps Connect and Scan readable in the narrow recovery card", () => {
    const connect = document.querySelector<HTMLButtonElement>("button[type='submit']");
    const scan = document.querySelector<HTMLButtonElement>("button[type='button']");
    const card = document.querySelector<HTMLElement>(".browser-backend-recovery section");
    if (!connect || !scan || !card) throw new Error("Missing recovery controls");

    card.style.width = "260px";
    card.style.maxWidth = "260px";

    expect(getComputedStyle(connect.parentElement!).display).toBe("grid");
    expect(getComputedStyle(connect).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(scan).whiteSpace).toBe("nowrap");
    expect(connect.scrollWidth).toBeLessThanOrEqual(connect.clientWidth);
    expect(scan.scrollWidth).toBeLessThanOrEqual(scan.clientWidth);

    card.style.width = "";
    card.style.maxWidth = "";
  });

  test("keeps the recovery UI when Connect targets an offline port", async () => {
    const connect = document.querySelector<HTMLButtonElement>("button[type='submit']");
    const input = document.querySelector<HTMLInputElement>("#browser-backend-recovery-port");
    const card = document.querySelector<HTMLElement>(".browser-backend-recovery section");
    if (!connect || !input || !card) throw new Error("Missing recovery controls");
    const cardTop = card.getBoundingClientRect().top;

    connect.click();

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>("[role='alert']")?.textContent).toContain(
        "Could not connect to Mish on port 5000",
      ),
    );
    expect(input.value).toBe("5000");
    expect(input.disabled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    const error = document.querySelector<HTMLElement>("[role='alert']");
    if (!error) throw new Error("Missing offline Connect error");
    expect(connect.parentElement?.nextElementSibling?.contains(error)).toBe(true);
    expect(Math.abs(card.getBoundingClientRect().top - cardTop)).toBeLessThan(0.1);
  });

  test("securely scans from 6474, updates the visible port, then enters Connect pending", async () => {
    const scan = document.querySelector<HTMLButtonElement>("button[type='button']");
    const input = document.querySelector<HTMLInputElement>("#browser-backend-recovery-port");
    if (!scan || !input) throw new Error("Missing recovery controls");

    visited.length = 0;
    scan.click();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("http://127.0.0.1:6476"));
    expect(visited).toEqual([6474, 6475, 6476, 6476]);
    expect(input.value).toBe("6476");
    expect(
      document.querySelector<HTMLButtonElement>("button[type='submit']")?.textContent,
    ).toContain("Connecting…");
    expect(input.disabled).toBe(true);
  });
});
