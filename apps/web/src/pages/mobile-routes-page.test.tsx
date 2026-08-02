import type {
  MobileConfigValidationResultDto,
  MobileVpnSnapshotDto,
  StatusCommand,
  StatusConnectionState,
  StatusSnapshotDto,
} from "@mish/contracts";
import { StatusClientError } from "@mish/contracts";
import { TooltipProvider } from "@mish/ui";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AppearanceProvider } from "../appearance";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import type { Locales } from "../i18n/i18n-types";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { AppRoutes } from "../mobile-app";
import type { MobileVpnClient } from "../platform/mobile-vpn-client";

loadAllLocales();

const fixture = {
  adapterKind: "native" as const,
  contractVersion: 1 as const,
  core: { availability: "unavailable" as const, kind: "fixture" as const },
  message: "Native fixture connected.",
  platform: "android" as const,
  targetAbis: ["arm64-v8a", "x86_64"] as ["arm64-v8a", "x86_64"],
  vpn: { availability: "unavailable" as const, kind: "fixture" as const },
};

const vpnSnapshot: MobileVpnSnapshotDto = {
  backendKind: "fixture",
  contractVersion: 1,
  coreAbiVersion: null,
  coreAvailability: "unavailable",
  coreCommit: null,
  coreConfigState: "unloaded",
  coreVersion: null,
  coreWrapperRevision: null,
  configFailureInjectionAvailable: false,
  foreground: false,
  loadedConfigDigest: null,
  loadedConfigRevision: null,
  message: "Fixture only.",
  notificationPermission: "required",
  permission: "required",
  phase: "permission-required",
  sequence: 1,
  sessionId: "mobile-routes-test",
  tunAvailability: "unavailable",
  updatedAtMillis: 1,
  validatedConfigDigest: null,
  validatedConfigRevision: null,
  vpnActive: false,
  vpnAvailability: "unavailable",
};

const vpnClient: MobileVpnClient = {
  dispose() {},
  getSnapshot: () => vpnSnapshot,
  initialize: async () => vpnSnapshot,
  loadConfig: async (_bytes, identity) => ({
    cancellation: "not-requested",
    contractVersion: 1,
    digest: identity.digest,
    failure: "core-unavailable",
    message: "The packaged Mobile Core is unavailable.",
    operationId: "mobile-routes-load",
    outcome: "failed",
    revision: identity.revision,
    rollback: "unloaded",
    snapshot: vpnSnapshot,
    timing: "on-time",
  }),
  requestNotificationPermission: async () => vpnSnapshot,
  requestVpnConsent: async () => vpnSnapshot,
  startFixtureLifecycle: async () => vpnSnapshot,
  stop: async () => vpnSnapshot,
  subscribe: (handler) => {
    handler(vpnSnapshot);
    return () => undefined;
  },
  validateConfig: async (): Promise<MobileConfigValidationResultDto> => ({
    contractVersion: 1,
    failure: "core-unavailable",
    message: "The packaged Mobile Core is unavailable.",
    outcome: "failed",
    sequence: vpnSnapshot.sequence,
    sessionId: vpnSnapshot.sessionId,
  }),
};

function renderMobileRoutes({
  client = new FixtureStatusClient(),
  entry = "/routes",
  locale = "en",
}: {
  client?: FixtureStatusClient;
  entry?: string;
  locale?: Locales;
} = {}) {
  return render(
    <AppearanceProvider>
      <TypesafeI18n locale={locale}>
        <MemoryRouter initialEntries={[entry]}>
          <ProductProvider client={client}>
            <TooltipProvider>
              <AppRoutes
                mobileFixture={fixture}
                mobileVpnClient={vpnClient}
                mobileVpnSnapshot={vpnSnapshot}
              />
            </TooltipProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
}

class UnsupportedCommandsClient extends FixtureStatusClient {
  override supportsCommand(_command: StatusCommand) {
    return false;
  }
}

class ReconnectingClient extends FixtureStatusClient {
  private connection: StatusConnectionState = { attempt: 0, phase: "connected", stale: false };
  private readonly listeners = new Set<(state: StatusConnectionState) => void>();

  override getConnectionState() {
    return { ...this.connection };
  }

  override subscribeConnection(listener: (state: StatusConnectionState) => void) {
    this.listeners.add(listener);
    listener(this.getConnectionState());
    return () => this.listeners.delete(listener);
  }

  reconnect() {
    this.connection = { attempt: 2, phase: "reconnecting", stale: true };
    for (const listener of this.listeners) listener(this.getConnectionState());
  }
}

class DeferredSelectionClient extends FixtureStatusClient {
  rejectSelection: (() => void) | null = null;
  selectionAttempts = 0;

  override selectGroupChild() {
    this.selectionAttempts += 1;
    return new Promise<StatusSnapshotDto>((_, reject) => {
      this.rejectSelection = () =>
        reject(new StatusClientError("conflict", "Group selection failed", true));
    });
  }
}

class DelayClient extends FixtureStatusClient {
  readonly startedGroupIds: string[] = [];

  override supportsCommand(command: StatusCommand) {
    return command === "group" || command === "group-delay";
  }

  override async startGroupDelayTest(groupId: string) {
    this.startedGroupIds.push(groupId);
    const snapshot = await this.getSnapshot();
    const group = snapshot.groups.find((candidate) => candidate.id === groupId);
    if (!group) throw new Error("Missing mobile Routes fixture group");
    snapshot.groupDelayTest = {
      children: group.childIds.map((childId) => ({
        childId,
        failure: null,
        latencyMilliseconds: null,
        observedAt: null,
        phase: "pending",
      })),
      finishedAt: null,
      groupId,
      phase: "pending",
      profileId: snapshot.activeProfileId,
      startedAt: 1_720_000_000_000,
      testId: "mobile-route-delay",
    };
    snapshot.applicationOrder.order += 1;
    return snapshot;
  }
}

describe("Android mobile Routes", () => {
  it("uses dedicated list, group, and child routes while preserving group-scoped selection", async () => {
    const user = userEvent.setup();
    const view = renderMobileRoutes();

    const proxy = await screen.findByRole("link", { name: "Browse 🌐 Proxy" });
    expect(view.container.querySelector(".mobile-route-scroller")).not.toBeNull();
    expect(view.container.querySelector(".routes-page")).toBeNull();
    expect(view.container.querySelector(".sidebar")).toBeNull();

    await user.click(proxy);
    expect(await screen.findByRole("heading", { name: "🌐 Proxy" })).toBeVisible();
    expect(view.container.querySelector(".mobile-policy-browser-toolbar")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Start Delay Test for 🌐 Proxy" })).toBeDisabled();
    const nrtSelection = screen.getByRole("button", {
      name: "Select 🇯🇵 NRT-03 in 🌐 Proxy",
    });
    await user.click(nrtSelection);
    await waitFor(() => expect(nrtSelection).toHaveAttribute("aria-pressed", "true"));

    await user.click(screen.getByRole("link", { name: "View Details for 🇯🇵 NRT-03" }));
    expect(await screen.findByRole("heading", { name: "🇯🇵 NRT-03" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/routes/proxy");
    expect(screen.getByRole("button", { name: "Select 🇯🇵 NRT-03 in 🌐 Proxy" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("link", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "🌐 Proxy" })).toBeVisible();
    await user.click(screen.getByRole("link", { name: "Back" }));
    expect(await screen.findByRole("link", { name: "Browse 🌐 Proxy" })).toBeVisible();
  });

  it("keeps sort and delay test state in the group route through the shared authoritative command", async () => {
    const user = userEvent.setup();
    const client = new DelayClient();
    renderMobileRoutes({ client, entry: "/routes/streaming" });

    expect(await screen.findByRole("heading", { name: "🎬 Streaming" })).toBeVisible();
    await user.click(screen.getByRole("combobox", { name: "Sort children in 🎬 Streaming" }));
    await user.click(await screen.findByRole("option", { name: "Latency" }));
    await user.click(screen.getByRole("button", { name: "Start Delay Test for 🎬 Streaming" }));

    expect(await screen.findByText(/0\/3/)).toBeVisible();
    expect(client.startedGroupIds).toEqual(["streaming"]);
    expect(
      screen.getByRole("button", { name: "Cancel Delay Test for 🎬 Streaming" }),
    ).toBeEnabled();
  });

  it("preserves group search and sort when returning from a child detail route", async () => {
    const user = userEvent.setup();
    renderMobileRoutes({ entry: "/routes/streaming" });

    const search = await screen.findByRole("searchbox", {
      name: "Search direct children of 🎬 Streaming",
    });
    await user.click(screen.getByRole("combobox", { name: "Sort children in 🎬 Streaming" }));
    await user.click(await screen.findByRole("option", { name: "Latency" }));
    await user.type(search, "NRT-03");
    await user.click(screen.getByRole("link", { name: "View Details for 🇯🇵 NRT-03" }));

    expect(await screen.findByRole("heading", { name: "🇯🇵 NRT-03" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute(
      "href",
      "/routes/streaming?sort=latency&query=NRT-03",
    );
    await user.click(screen.getByRole("link", { name: "Back" }));

    expect(
      await screen.findByRole("searchbox", { name: "Search direct children of 🎬 Streaming" }),
    ).toHaveValue("NRT-03");
    expect(
      screen.getByRole("combobox", { name: "Sort children in 🎬 Streaming" }),
    ).toHaveTextContent("Latency");
  });

  it("explains unavailable mobile commands without changing the confirmed selection", async () => {
    const client = new UnsupportedCommandsClient();
    renderMobileRoutes({ client, entry: "/routes/streaming" });

    expect(
      await screen.findByText(/cannot change a selection or run a delay test yet/),
    ).toBeVisible();
    const confirmed = screen.getByRole("button", {
      name: "Select 🇸🇬 SIN-01 in 🎬 Streaming",
    });
    expect(confirmed).toHaveAttribute("aria-pressed", "true");
    expect(confirmed).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Start Delay Test for 🎬 Streaming" }),
    ).toBeDisabled();
  });

  it("preserves the confirmed child, reports reconnecting state, and restores focus after a failed choice", async () => {
    const user = userEvent.setup();
    const client = new DeferredSelectionClient();
    const view = renderMobileRoutes({ client, entry: "/routes/streaming" });

    const target = await screen.findByRole("button", {
      name: "Select 🇯🇵 NRT-03 in 🎬 Streaming",
    });
    const confirmed = screen.getByRole("button", {
      name: "Select 🇸🇬 SIN-01 in 🎬 Streaming",
    });
    await user.click(target);

    expect(target).toHaveAttribute("aria-busy", "true");
    expect(target).toHaveAttribute("aria-pressed", "false");
    expect(confirmed).toHaveAttribute("aria-pressed", "true");
    expect(confirmed).toBeDisabled();
    expect(client.selectionAttempts).toBe(1);

    client.rejectSelection?.();
    await waitFor(() => expect(target).not.toHaveAttribute("aria-busy"));
    await waitFor(() => expect(target).toHaveFocus());

    view.unmount();
    const reconnecting = new ReconnectingClient();
    renderMobileRoutes({ client: reconnecting, entry: "/routes/streaming" });
    await screen.findByRole("heading", { name: "🎬 Streaming" });
    reconnecting.reconnect();

    expect(await screen.findByText(/Routes are reconnecting/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Select 🇯🇵 NRT-03 in 🎬 Streaming" })).toBeDisabled();
  });
});
