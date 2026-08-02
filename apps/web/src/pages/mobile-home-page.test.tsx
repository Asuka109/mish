import type {
  MobileConfigLoadResultDto,
  MobileConfigValidationResultDto,
  MobileVpnSnapshotDto,
} from "@mish/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import type { MobileVpnClient } from "../platform/mobile-vpn-client";
import { MobileHomePage } from "./mobile-home-page";

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

const initialSnapshot: MobileVpnSnapshotDto = {
  authorityId: "mobile-home-authority",
  backendKind: "fixture",
  contractVersion: 1,
  coreAbiVersion: null,
  coreAvailability: "unavailable",
  coreCommit: null,
  configFailureInjectionAvailable: false,
  coreConfigState: "unloaded",
  coreVersion: null,
  coreWrapperRevision: null,
  foreground: false,
  loadedConfigDigest: null,
  loadedConfigRevision: null,
  message: "Fixture only. No TUN or Core is available.",
  notificationPermission: "required",
  operation: null,
  permission: "required",
  phase: "permission-required",
  revision: 1,
  sequence: 1,
  sessionId: "session-1",
  updatedAtMillis: 1,
  validatedConfigDigest: null,
  validatedConfigRevision: null,
  vpnActive: false,
  vpnAvailability: "unavailable",
  tunAvailability: "unavailable",
};

class TestMobileVpnClient implements MobileVpnClient {
  readonly requestNotificationPermission = vi.fn(async () => this.snapshot);
  readonly requestVpnConsent = vi.fn(async () => this.snapshot);
  readonly startFixtureLifecycle = vi.fn(async () => this.snapshot);
  readonly stop = vi.fn(async () => this.snapshot);
  readonly loadConfig = vi.fn(
    async (
      _bytes: Uint8Array,
      identity: { digest: string; revision: string },
    ): Promise<MobileConfigLoadResultDto> => {
      const next = {
        ...this.snapshot,
        coreConfigState: "loaded" as const,
        loadedConfigDigest: identity.digest,
        loadedConfigRevision: identity.revision,
        sequence: this.snapshot.sequence + 1,
        validatedConfigDigest: identity.digest,
        validatedConfigRevision: identity.revision,
      };
      this.publish(next);
      return {
        cancellation: "not-requested",
        contractVersion: 1,
        digest: identity.digest,
        failure: null,
        message: "Configuration loaded. VPN and TUN remain unavailable.",
        operationId: "test-load",
        outcome: "first-load",
        revision: identity.revision,
        rollback: "not-needed",
        snapshot: next,
        timing: "on-time",
      };
    },
  );
  private readonly subscribers = new Set<(snapshot: MobileVpnSnapshotDto) => void>();

  constructor(private snapshot: MobileVpnSnapshotDto = initialSnapshot) {}

  dispose() {}

  getSnapshot() {
    return this.snapshot;
  }

  async initialize() {
    return this.snapshot;
  }

  async validateConfig(): Promise<MobileConfigValidationResultDto> {
    return {
      contractVersion: 1,
      failure: "core-unavailable",
      message: "The packaged Mobile Core is unavailable.",
      outcome: "failed",
      sequence: this.snapshot.sequence,
      sessionId: this.snapshot.sessionId,
    };
  }

  subscribe(handler: (snapshot: MobileVpnSnapshotDto) => void) {
    this.subscribers.add(handler);
    handler(this.snapshot);
    return () => this.subscribers.delete(handler);
  }

  publish(snapshot: MobileVpnSnapshotDto) {
    this.snapshot = snapshot;
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }
}

function renderHome(client = new TestMobileVpnClient(), locale: "en" | "zh" = "en") {
  return {
    client,
    ...render(
      <TypesafeI18n locale={locale}>
        <MobileHomePage fixture={fixture} initialSnapshot={initialSnapshot} vpnClient={client} />
      </TypesafeI18n>,
    ),
  };
}

describe("MobileHomePage", () => {
  it("leads with native VPN authority and requests permission without a React pending projection", async () => {
    const { client, container } = renderHome();
    const authority = container.querySelector(".mobile-home-authority");
    const currentSetup = screen.getByRole("heading", { name: "Current setup" });

    expect(authority).not.toBeNull();
    expect(authority!.compareDocumentPosition(currentSetup)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByRole("heading", { name: "VPN permission required" })).toBeVisible();
    expect(screen.getByText("Profile").closest(".section-grid-item")).toHaveTextContent(
      "Unavailable",
    );
    expect(screen.getByText("Routing mode").closest(".section-grid-item")).toHaveTextContent(
      "Unavailable",
    );
    expect(screen.getByText("Live throughput").closest(".section-grid-item")).toHaveTextContent(
      "Unavailable",
    );
    expect(screen.queryByText("Studio route set")).not.toBeInTheDocument();
    expect(screen.queryByText(/MB\/s/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review VPN Permission" }));

    expect(client.requestVpnConsent).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Review VPN Permission" })).not.toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("projects busy and terminal states only after an authoritative snapshot arrives", async () => {
    const client = new TestMobileVpnClient();
    renderHome(client);

    client.publish({
      ...initialSnapshot,
      notificationPermission: "granted",
      permission: "granted",
      phase: "starting",
      sequence: 2,
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Checking native lifecycle" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Pending" })).toBeDisabled();
    });

    client.publish({
      ...initialSnapshot,
      foreground: true,
      notificationPermission: "granted",
      permission: "granted",
      phase: "unavailable",
      sequence: 3,
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "VPN unavailable" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Stop Lifecycle Check" })).toBeEnabled();
    });
    expect(screen.getByText(/No device traffic is being routed/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Stop Lifecycle Check" }));
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("replaces a terminal failure with a direct native retry action", async () => {
    const client = new TestMobileVpnClient();
    renderHome(client);

    client.publish({
      ...initialSnapshot,
      notificationPermission: "granted",
      permission: "granted",
      phase: "failed",
      sequence: 2,
    });

    const retry = await screen.findByRole("button", { name: "Retry Lifecycle Check" });
    expect(screen.getByRole("heading", { name: "Lifecycle check failed" })).toBeVisible();
    fireEvent.click(retry);
    expect(client.startFixtureLifecycle).toHaveBeenCalledOnce();
  });

  it("shows verified package identity without claiming a current Profile, route, or traffic", () => {
    const client = new TestMobileVpnClient({
      ...initialSnapshot,
      coreAbiVersion: 1,
      coreAvailability: "available",
      coreCommit: "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb",
      coreVersion: "v1.19.29",
      coreWrapperRevision: "mish-mobile-core-v1",
    });

    renderHome(client);

    expect(screen.getByText("Mihomo v1.19.29")).toBeVisible();
    expect(
      screen.getByText(
        "Package identity is verified. Loading does not initialize VPN/TUN or start traffic handling.",
      ),
    ).toBeVisible();
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
  });

  it("loads the bounded fictional revision while keeping VPN and TUN unavailable", async () => {
    const client = new TestMobileVpnClient({
      ...initialSnapshot,
      coreAbiVersion: 1,
      coreAvailability: "available",
      coreCommit: "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb",
      coreVersion: "v1.19.29",
      coreWrapperRevision: "mish-mobile-core-v1",
    });
    renderHome(client);

    fireEvent.click(screen.getByRole("button", { name: "Load Fixture A" }));

    await waitFor(() => {
      expect(screen.getByText("Loaded · fictional-a-v1")).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Configuration loaded. VPN and TUN remain unavailable.",
      );
    });
    expect(client.loadConfig).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "VPN permission required" })).toBeVisible();
    expect(screen.queryByText(/No configuration is loaded/)).not.toBeInTheDocument();
  });

  it("keeps the development fixture evidence bounded in Simplified Chinese", () => {
    const { container } = renderHome(new TestMobileVpnClient(), "zh");
    const notice = container.querySelector(".mobile-home-fixture-notice");

    expect(notice).toHaveTextContent("开发边界");
    expect(notice).toHaveTextContent("无法启动代理、创建虚拟网卡或转发设备流量");
    expect(container.querySelector(".mobile-fixture-banner")).toBeNull();
  });
});
