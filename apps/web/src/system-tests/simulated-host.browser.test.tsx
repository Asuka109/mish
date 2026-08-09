import {
  BRIDGE_INFO_REQUEST,
  BridgeInfoSchema,
  mishRpcMethods,
  resolveBridgeProtocolCompatibility,
  type SettingsSnapshotDto,
} from "@mish/contracts";
import { RpcClient } from "@mish/rpc-client";
import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeAll, expect, inject, onTestFailed, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppearanceProvider } from "../appearance";
import { NotificationBubble } from "../components/notification-bubble";
import { NotificationToaster } from "../components/notification-toaster";
import { NotificationDeliveryProvider } from "../data/notification-delivery";
import { ProductProvider } from "../data/product-provider";
import { RpcNotificationClient } from "../data/rpc-notification-client";
import { RpcSettingsClient } from "../data/rpc-settings-client";
import { RpcStatusClient } from "../data/rpc-status-client";
import { SettingsProvider } from "../data/settings-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { StatusPage } from "../pages/status-page";
import "../styles.css";
import type {
  SimulatedHostHarnessDescriptor,
  SimulatedHostScenarioName,
} from "./simulated-host-global-setup";

interface SemanticTranscriptEvent {
  admittedRevision: number;
  authorityId: string;
  effectId: number;
  effectKind: string;
  logicalTime: number;
  operationId: number | null;
  resultKind: string;
  runtimeId: string;
  scopeEpoch: number;
}

interface HarnessEvidence {
  logicalTime: number;
  scenario: SimulatedHostScenarioName;
  signals: {
    journalPresent: boolean;
    maintenance: null | {
      activeOperation: number | null;
      captureRestorePending: boolean;
      journalPresent: boolean;
      package: string;
      recoveryRequired: boolean;
    };
    pendingProxyPropagation: boolean;
    preparationPhase: string;
  };
  terminalAuthority: {
    captureOperation: {
      failure: string | null;
      operationId: string | null;
      phase: string;
      scopeEpoch: number | null;
    };
    identity: null | {
      admittedRevision: number;
      authorityId: string;
      runtimeId: string;
      scopeEpoch: number;
    };
    notifications: Array<{
      failure: string | null;
      kind: string;
      operation: string | null;
      outcome: string | null;
      pinned: boolean;
      presentationPhase: string;
      resolved: boolean;
      revision: number;
    }>;
    systemProxy: { enabled: boolean; failure: string | null; observed: string; phase: string };
    tun: { enabled: boolean; failure: string | null; observed: string; phase: string };
    tunHelper: null | {
      availability: string;
      health: string;
      lastFailure: string | null;
      phase: string;
      revision: number;
    };
  };
  transcript: { events: SemanticTranscriptEvent[]; schemaVersion: number };
}

interface MountedScenario {
  notificationClient: RpcNotificationClient;
  root: Root;
  rpc: RpcClient<typeof mishRpcMethods>;
  settingsClient: RpcSettingsClient | null;
  statusClient: RpcStatusClient;
}

const harnesses = inject("simulatedHostHarnesses");
let mounted: MountedScenario | null = null;

function ScenarioApplication({
  notificationClient,
  settingsClient,
  settingsSnapshot,
  statusClient,
}: {
  notificationClient: RpcNotificationClient;
  settingsClient: RpcSettingsClient | null;
  settingsSnapshot: SettingsSnapshotDto | null;
  statusClient: RpcStatusClient;
}) {
  const application = (
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
  );
  return (
    <TypesafeI18n locale="en">
      {settingsClient && settingsSnapshot ? (
        <SettingsProvider client={settingsClient} initialSnapshot={settingsSnapshot}>
          {application}
        </SettingsProvider>
      ) : (
        application
      )}
    </TypesafeI18n>
  );
}

function createRpc(harness: SimulatedHostHarnessDescriptor) {
  return new RpcClient({
    authentication: () => ({
      clientName: `mish-simulated-host-${harness.scenario}`,
      clientVersion: "1",
      token: harness.authToken,
    }),
    compatibility: {
      method: "bridge.getInfo",
      outcome: (result) => resolveBridgeProtocolCompatibility(BridgeInfoSchema.parse(result)),
      params: BRIDGE_INFO_REQUEST,
      resultSchema: BridgeInfoSchema,
    },
    methods: mishRpcMethods,
    transportFactory: () => new WebSocket(harness.rpcUrl),
  });
}

async function mountScenario(scenario: SimulatedHostScenarioName, withSettings = false) {
  const harness = harnesses[scenario];
  const rpc = createRpc(harness);
  const statusClient = new RpcStatusClient(rpc, true);
  const notificationClient = new RpcNotificationClient(rpc);
  const settingsClient = withSettings ? new RpcSettingsClient(rpc, true) : null;
  const settingsSnapshot = settingsClient ? await settingsClient.getSnapshot() : null;
  const container = document.getElementById("simulated-host-browser-root");
  if (!container) throw new Error("Missing simulated host browser root");
  const root = createRoot(container);
  root.render(
    <ScenarioApplication
      notificationClient={notificationClient}
      settingsClient={settingsClient}
      settingsSnapshot={settingsSnapshot}
      statusClient={statusClient}
    />,
  );
  mounted = { notificationClient, root, rpc, settingsClient, statusClient };
  return mounted;
}

function unmountScenario() {
  mounted?.root.unmount();
  mounted?.notificationClient.dispose();
  mounted?.statusClient.dispose();
  mounted = null;
}

async function control(
  scenario: SimulatedHostScenarioName,
  action: string,
  method: "GET" | "POST" = "POST",
) {
  const harness = harnesses[scenario];
  const response = await fetch(`${harness.controlUrl}/${action}/${harness.controlKey}`, { method });
  if (!response.ok) throw new Error(`Simulated host control ${action} was rejected`);
  return response.json() as Promise<HarnessEvidence>;
}

function observation(scenario: SimulatedHostScenarioName) {
  return control(scenario, "observation", "GET");
}

function advanceTo(scenario: SimulatedHostScenarioName, logicalTime: number) {
  return control(scenario, `advance/${String(logicalTime)}`);
}

function registerFailureEvidence(scenario: SimulatedHostScenarioName, assertionContext: string) {
  onTestFailed(async () => {
    try {
      const current = await observation(scenario);
      const report = {
        assertionContext,
        logicalTime: current.logicalTime,
        scenario,
        semanticTranscript: {
          events: current.transcript.events.slice(-32),
          schemaVersion: current.transcript.schemaVersion,
        },
        terminalAuthority: current.terminalAuthority,
      };
      console.error(`MISH_SIMULATED_FAILURE ${JSON.stringify(report)}`);
    } catch {
      console.error(
        `MISH_SIMULATED_FAILURE ${JSON.stringify({ assertionContext, evidence: "unavailable", scenario })}`,
      );
    }
  });
}

function systemProxyButton() {
  return page.getByRole("button", { name: /^System Proxy/ });
}

function virtualInterfaceButton() {
  return page.getByRole("button", { name: /^Virtual Interface/ });
}

beforeAll(() => {
  loadAllLocales();
  document.body.innerHTML = '<div id="simulated-host-browser-root"></div>';
});

afterEach(() => {
  unmountScenario();
  document.getElementById("simulated-host-browser-root")?.replaceChildren();
});

test("early managed-port failure survives reconnect/remount and delayed cleanup", async () => {
  const scenario = "early-conflict";
  registerFailureEvidence(
    scenario,
    "early notification, duplicate suppression, reconnect/remount pending, matching terminal cleanup",
  );
  await mountScenario(scenario);
  const systemProxy = systemProxyButton();
  await expect.element(systemProxy).toBeEnabled();

  await userEvent.click(systemProxy);
  await vi.waitFor(async () => {
    expect((await observation(scenario)).signals.preparationPhase).toBe("finalizing");
  });
  expect((await observation(scenario)).terminalAuthority.captureOperation).toMatchObject({
    failure: "listener-unavailable",
    phase: "finalizing",
  });
  await expect.element(systemProxy).toBeDisabled();
  await expect.element(systemProxy).toHaveAttribute("aria-busy", "true");
  await expect
    .element(page.getByText("Mish could not use 127.0.0.1:7890.", { exact: true }))
    .toBeVisible();

  (systemProxy.element() as HTMLButtonElement).click();
  const beforeRemount = await observation(scenario);
  expect(
    beforeRemount.transcript.events.filter(
      ({ effectKind }) => effectKind === "profile-preparation",
    ),
  ).toHaveLength(1);
  unmountScenario();
  await mountScenario(scenario);
  await expect.element(systemProxyButton()).toBeDisabled();
  await expect.element(systemProxyButton()).toHaveAttribute("aria-busy", "true");
  const finalizingFeedback = document.querySelector<HTMLElement>(
    '[data-capture-operation-phase="finalizing"]',
  );
  expect(finalizingFeedback).toHaveClass("sr-only");
  expect(finalizingFeedback).toHaveTextContent("Finishing the change");

  await advanceTo(scenario, 20);
  await vi.waitFor(async () => {
    expect((await observation(scenario)).signals.preparationPhase).toBe("complete");
  });
  await expect.element(systemProxyButton()).toBeEnabled();
  await expect.element(systemProxyButton()).not.toHaveAttribute("aria-busy", "true");
  const terminal = await observation(scenario);
  expect(terminal.terminalAuthority.captureOperation.phase).toBe("failed");
  expect(
    terminal.transcript.events.some(
      ({ effectKind, resultKind }) =>
        effectKind === "finalize-operation" && resultKind === "completed",
    ),
  ).toBe(true);
});

test("commit-time managed-port drift never reaches Applied", async () => {
  const scenario = "commit-drift";
  registerFailureEvidence(
    scenario,
    "second managed-port check rejects commit-time drift before Capture apply",
  );
  await mountScenario(scenario);
  await userEvent.click(systemProxyButton());
  await vi.waitFor(async () => {
    expect(
      (await observation(scenario)).transcript.events.some(
        ({ effectKind, resultKind }) =>
          effectKind === "managed-endpoint-ownership-check-early" && resultKind === "free",
      ),
    ).toBe(true);
  });
  await advanceTo(scenario, 5);
  await advanceTo(scenario, 10);
  await expect
    .element(page.getByText("Mish could not use 127.0.0.1:7890.", { exact: true }))
    .toBeVisible();
  await expect.element(systemProxyButton()).toBeDisabled();
  await vi.waitFor(async () => {
    expect((await observation(scenario)).terminalAuthority.captureOperation.phase).toBe(
      "finalizing",
    );
  });

  await advanceTo(scenario, 20);
  await vi.waitFor(async () => {
    expect((await observation(scenario)).terminalAuthority.captureOperation.phase).toBe("failed");
  });
  const terminal = await observation(scenario);
  expect(terminal.transcript.events.some(({ effectKind }) => effectKind === "capture-apply")).toBe(
    false,
  );
});

test("confirmed rollback retains the prior System Proxy authority", async () => {
  const scenario = "confirmed-rollback";
  registerFailureEvidence(
    scenario,
    "partial System Proxy write compensates to the exact prior state and terminal Failed",
  );
  await mountScenario(scenario);
  await userEvent.click(systemProxyButton());
  await vi.waitFor(async () => {
    expect((await observation(scenario)).terminalAuthority.captureOperation.phase).toBe("failed");
  });
  await expect.element(systemProxyButton()).toBeEnabled();
  await expect.element(systemProxyButton()).toHaveAttribute("aria-pressed", "false");
  expect(
    document.querySelector<HTMLElement>('[data-capture-operation-phase="error"]'),
  ).toBeEmptyDOMElement();
  const terminal = await observation(scenario);
  expect(terminal.signals.journalPresent).toBe(false);
  expect(terminal.terminalAuthority.systemProxy).toMatchObject({
    enabled: false,
    observed: "other",
    phase: "failed",
  });
});

test("unconfirmed rollback projects Recovery Required without false success", async () => {
  const scenario = "recovery-required";
  registerFailureEvidence(
    scenario,
    "unconfirmed compensation keeps recovery journal and projects Recovery Required",
  );
  await mountScenario(scenario);
  await userEvent.click(systemProxyButton());
  await vi.waitFor(async () => {
    expect((await observation(scenario)).terminalAuthority.captureOperation.phase).toBe(
      "recovery-required",
    );
  });
  await expect.element(systemProxyButton()).toBeEnabled();
  await expect.element(systemProxyButton()).toHaveAttribute("aria-pressed", "false");
  await expect
    .element(
      page.getByText(
        "System Proxy differs from Mish's requested state. Repair it or leave the current OS settings as is.",
        { exact: false },
      ),
    )
    .toBeInTheDocument();
  const terminal = await observation(scenario);
  expect(terminal.signals.journalPresent).toBe(true);
  expect(terminal.terminalAuthority.systemProxy.phase).toBe("drift");
});

for (const [scenario, action] of [
  ["helper-install", "Install System Component"],
  ["helper-repair", "Repair System Component"],
] as const) {
  test(`${action} follows authenticated Settings and Rust maintenance authority`, async () => {
    registerFailureEvidence(
      scenario,
      `${action} dialog remains pending through Rust finalization and closes on confirmed Helper health`,
    );
    await mountScenario(scenario, true);
    await userEvent.click(virtualInterfaceButton());
    await expect
      .element(page.getByRole("dialog", { name: "Before enabling Virtual Interface" }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: action }));
    await vi.waitFor(async () => {
      expect((await observation(scenario)).signals.maintenance?.journalPresent).toBe(true);
    });
    const pendingAction = page.getByRole("button", {
      name:
        scenario === "helper-install"
          ? "Waiting for macOS permission…"
          : "Repairing system component…",
    });
    await expect.element(pendingAction).toBeDisabled();
    await expect.element(pendingAction).toHaveAttribute("aria-busy", "true");
    expect((await observation(scenario)).terminalAuthority.notifications).toContainEqual(
      expect.objectContaining({
        kind: "tun-helper.lifecycle",
        operation: scenario === "helper-install" ? "install" : "repair",
        outcome: "finalizing",
        pinned: true,
      }),
    );

    await advanceTo(scenario, 1);
    await vi.waitFor(async () => {
      expect((await observation(scenario)).terminalAuthority.tunHelper).toMatchObject({
        availability: "available",
        health: "healthy",
        phase: "idle",
      });
    });
    await expect
      .element(page.getByRole("dialog", { name: "Before enabling Virtual Interface" }))
      .not.toBeInTheDocument();
    await expect.element(virtualInterfaceButton()).toBeEnabled();
  });
}

test("cancellation keeps single-flight ownership through finalization", async () => {
  const scenario = "cancelled";
  registerFailureEvidence(
    scenario,
    "matching Rust cancellation remains Finalizing until one owned finalizer reaches terminal",
  );
  await mountScenario(scenario);
  await userEvent.click(systemProxyButton());
  await vi.waitFor(async () => {
    expect(
      (await observation(scenario)).transcript.events.some(
        ({ effectKind }) => effectKind === "profile-preparation",
      ),
    ).toBe(true);
  });
  await control(scenario, "cancel-activation");
  await expect.element(systemProxyButton()).toBeDisabled();
  await vi.waitFor(async () => {
    expect((await observation(scenario)).terminalAuthority.captureOperation.phase).toBe(
      "finalizing",
    );
  });
  await advanceTo(scenario, 20);
  await vi.waitFor(async () => {
    expect((await observation(scenario)).terminalAuthority.captureOperation.phase).toBe("failed");
  });
  const terminal = await observation(scenario);
  expect(
    terminal.transcript.events.filter(({ effectKind }) => effectKind === "finalize-operation"),
  ).toHaveLength(1);
});

test("runtime replacement retires an equal-target stale completion", async () => {
  const scenario = "replacement";
  registerFailureEvidence(
    scenario,
    "replacement authority remains Idle after the retired Runtime completes the equal target",
  );
  await mountScenario(scenario);
  await userEvent.click(systemProxyButton());
  await vi.waitFor(async () => {
    expect((await observation(scenario)).signals.pendingProxyPropagation).toBe(true);
  });
  const oldOperation = (await observation(scenario)).terminalAuthority.captureOperation.operationId;
  expect(oldOperation).not.toBeNull();
  await control(scenario, "replace-runtime");
  await vi.waitFor(async () => {
    expect((await observation(scenario)).terminalAuthority.captureOperation.phase).toBe("idle");
  });
  await expect.element(systemProxyButton()).toBeEnabled();
  await expect.element(systemProxyButton()).toHaveAttribute("aria-pressed", "false");

  await advanceTo(scenario, 5);
  const terminal = await observation(scenario);
  expect(terminal.terminalAuthority.captureOperation.phase).toBe("idle");
  expect(terminal.terminalAuthority.captureOperation.operationId).toBeNull();
  expect(terminal.terminalAuthority.systemProxy.enabled).toBe(false);
  expect(
    terminal.transcript.events.some(
      ({ logicalTime, operationId, runtimeId }) =>
        logicalTime === 5 && String(operationId) === oldOperation && runtimeId === "runtime-one",
    ),
  ).toBe(true);
});
