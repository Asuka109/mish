import { TooltipProvider } from "@mish/ui";
import { mishRpcMethods } from "@mish/contracts";
import { RpcClient } from "@mish/rpc-client";
import { page, userEvent } from "vitest/browser";
import { afterAll, beforeAll, expect, inject, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppearanceProvider } from "../appearance";
import { NotificationBubble } from "../components/notification-bubble";
import { NotificationToaster } from "../components/notification-toaster";
import { NotificationDeliveryProvider } from "../data/notification-delivery";
import { ProductProvider } from "../data/product-provider";
import { RpcNotificationClient } from "../data/rpc-notification-client";
import { RpcStatusClient } from "../data/rpc-status-client";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { StatusPage } from "../pages/status-page";
import "../styles.css";

const harness = inject("simulatedHostHarness");
let notificationClient: RpcNotificationClient;
let root: Root;
let rpc: RpcClient<typeof mishRpcMethods>;
let statusClient: RpcStatusClient;

function Harness() {
  return (
    <TypesafeI18n locale="en">
      <AppearanceProvider initialPreference="light" initialWindowSurfacePreference="opaque">
        <MemoryRouter initialEntries={["/status"]}>
          <ProductProvider client={statusClient}>
            <NotificationDeliveryProvider client={notificationClient}>
              <TooltipProvider>
                <StatusPage />
                <NotificationBubble />
                <NotificationToaster />
              </TooltipProvider>
            </NotificationDeliveryProvider>
          </ProductProvider>
        </MemoryRouter>
      </AppearanceProvider>
    </TypesafeI18n>
  );
}

async function observation() {
  const response = await fetch(`${harness.controlUrl}/observation/${harness.controlKey}`);
  if (!response.ok) throw new Error("Unable to read simulated host observation");
  return response.json() as Promise<{
    journalPresent: boolean;
    pendingProxyPropagation: boolean;
    preparationPhase: string;
    transcript: {
      events: Array<{ effectKind: string; resultKind: string }>;
    };
  }>;
}

async function primeSystemProxy() {
  const response = await fetch(`${harness.controlUrl}/prime-system-proxy/${harness.controlKey}`, {
    method: "POST",
  });
  if (!response.ok) throw new Error("Unable to prime the simulated System Proxy transaction");
}

async function auditSystemProxy() {
  const response = await fetch(`${harness.controlUrl}/audit-system-proxy/${harness.controlKey}`, {
    method: "POST",
  });
  if (!response.ok) throw new Error("Unable to audit the simulated System Proxy transaction");
}

async function advanceTo(logicalTime: number) {
  const response = await fetch(
    `${harness.controlUrl}/advance/${harness.controlKey}/${String(logicalTime)}`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error("Unable to advance simulated host logical time");
  return response.json();
}

beforeAll(() => {
  loadAllLocales();
  document.body.innerHTML = '<div id="simulated-host-browser-root"></div>';
  rpc = new RpcClient({
    authentication: () => ({
      clientName: "mish-simulated-host-browser-test",
      clientVersion: "1",
      token: harness.authToken,
    }),
    methods: mishRpcMethods,
    transportFactory: () => new WebSocket(harness.rpcUrl),
  });
  statusClient = new RpcStatusClient(rpc, true);
  notificationClient = new RpcNotificationClient(rpc);
  const container = document.getElementById("simulated-host-browser-root");
  if (!container) throw new Error("Missing simulated host browser root");
  root = createRoot(container);
  root.render(<Harness />);
});

afterAll(() => {
  root?.unmount();
  notificationClient?.dispose();
  statusClient?.dispose();
});

test("System Proxy stays authoritative and loading-bound through early conflict finalization", async () => {
  const systemProxy = page.getByRole("button", {
    name: /^System Proxy/,
  });
  await expect.element(systemProxy).toBeEnabled();

  await userEvent.click(systemProxy);
  await vi.waitFor(async () => {
    expect((await observation()).preparationPhase).toBe("finalizing");
  });
  await expect.element(systemProxy).toBeDisabled();
  await expect.element(systemProxy).toHaveAttribute("aria-busy", "true");
  await expect
    .element(page.getByText("Mish could not use 127.0.0.1:7890.", { exact: true }))
    .toBeVisible();

  (systemProxy.element() as HTMLButtonElement).click();
  const beforeCleanup = await observation();
  expect(
    beforeCleanup.transcript.events.filter(
      ({ effectKind }) => effectKind === "profile-preparation",
    ),
  ).toHaveLength(1);
  expect(
    beforeCleanup.transcript.events.some(({ effectKind }) => effectKind === "cleanup-candidate"),
  ).toBe(false);
  await expect.element(systemProxy).toBeDisabled();

  await advanceTo(20);
  await vi.waitFor(async () => {
    expect((await observation()).preparationPhase).toBe("complete");
  });
  await expect.element(systemProxy).toBeEnabled();
  await expect.element(systemProxy).not.toHaveAttribute("aria-busy", "true");
  const terminal = await observation();
  expect(
    terminal.transcript.events.some(
      ({ effectKind, resultKind }) =>
        effectKind === "finalize-operation" && resultKind === "completed",
    ),
  ).toBe(true);
  expect(terminal.transcript.events.some(({ effectKind }) => effectKind === "capture-apply")).toBe(
    false,
  );
});

test("System Proxy feedback follows real pending, applied, and restored RPC authority", async () => {
  const systemProxy = page.getByRole("button", {
    name: /^System Proxy/,
  });

  await primeSystemProxy();
  await vi.waitFor(async () => {
    expect((await observation()).pendingProxyPropagation).toBe(true);
  });
  await expect.element(systemProxy).toBeDisabled();

  await advanceTo(26);
  await vi.waitFor(async () => {
    expect((await observation()).pendingProxyPropagation).toBe(false);
  });
  await expect.element(systemProxy).toBeEnabled();
  await expect.element(systemProxy).toHaveAttribute("aria-pressed", "true");
  await expect
    .element(page.getByText("System Proxy is applied and confirmed by macOS.", { exact: false }))
    .toBeInTheDocument();

  await userEvent.click(systemProxy);
  await vi.waitFor(async () => {
    expect((await observation()).pendingProxyPropagation).toBe(true);
  });
  await expect.element(systemProxy).toBeDisabled();
  await expect.element(systemProxy).toHaveAttribute("aria-busy", "true");
  await expect
    .element(page.getByText("System Proxy is pending macOS confirmation.", { exact: false }))
    .toBeInTheDocument();

  await advanceTo(31);
  await vi.waitFor(async () => {
    const model = await observation();
    expect(model.pendingProxyPropagation).toBe(false);
    expect(model.journalPresent).toBe(false);
  });
  await expect.element(systemProxy).toBeEnabled();
  await expect.element(systemProxy).toHaveAttribute("aria-pressed", "false");
  await expect.element(systemProxy).not.toHaveAttribute("aria-busy", "true");
  await expect
    .element(page.getByText("System Proxy is off and confirmed by macOS.", { exact: false }))
    .toBeInTheDocument();

  await primeSystemProxy();
  await vi.waitFor(async () => {
    expect((await observation()).pendingProxyPropagation).toBe(true);
  });
  await advanceTo(36);
  await expect.element(systemProxy).toHaveAttribute("aria-pressed", "true");

  await advanceTo(40);
  await auditSystemProxy();
  await expect.element(systemProxy).toBeEnabled();
  await expect.element(systemProxy).not.toHaveAttribute("aria-busy", "true");
  await expect
    .element(
      page.getByText(
        "System Proxy differs from Mish's requested state. Repair it or leave the current OS settings as is.",
        { exact: false },
      ),
    )
    .toBeInTheDocument();
});
