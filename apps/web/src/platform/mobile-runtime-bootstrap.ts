import {
  MobileFixtureBootstrapSchema,
  type MobileFixtureBootstrapDto,
  type StatusCommand,
} from "@mish/contracts";
import { invoke } from "@tauri-apps/api/core";
import { FixtureEventsClient } from "../data/fixture-events-client";
import { FixtureProfileClient } from "../data/fixture-profile-client";
import { FixtureSettingsClient } from "../data/fixture-settings-client";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { FixtureTrafficClient } from "../data/fixture-traffic-client";
import { UnavailableLocalBackupClient } from "./local-backup";
import type { StartupStatusClient } from "./runtime-bootstrap";
import { UnavailableSupportBundleClient } from "./support-bundle";
import { MobileVpnFixtureClient, type MobileVpnClient } from "./mobile-vpn-client";

interface MobileBootstrapDependencies {
  invokeBootstrap(): Promise<unknown>;
  mobileVpnClient: MobileVpnClient;
}

const defaultDependencies: MobileBootstrapDependencies = {
  invokeBootstrap: () => invoke("mobile_fixture_bootstrap"),
  mobileVpnClient: new MobileVpnFixtureClient(),
};

class MobileFixtureStatusClient extends FixtureStatusClient {
  constructor(private readonly fixture: MobileFixtureBootstrapDto) {
    super();
  }

  override getConnectionState() {
    return { attempt: 0, phase: "connected" as const, stale: false };
  }

  override async getSnapshot(options?: { signal?: AbortSignal }) {
    const snapshot = await super.getSnapshot(options);
    snapshot.adapterKind = "native";
    snapshot.capabilities = { systemProxy: "unavailable", tun: "unavailable" };
    snapshot.runtime = {
      captureSelection: { systemProxy: false, tun: false },
      message: this.fixture.message,
      phase: "inactive",
      systemProxy: {
        desired: false,
        failure: null,
        observed: "disabled",
        phase: "off",
        recoveryActions: [],
      },
      systemProxyEnabled: false,
      tun: { desired: false, failure: null, observed: "disabled", phase: "off" },
      tunEnabled: false,
    };
    return snapshot;
  }

  override supportsCommand(_command: StatusCommand) {
    return false;
  }
}

class MobileFixtureTrafficClient extends FixtureTrafficClient {
  override getConnectionState() {
    return { attempt: 0, phase: "connected" as const, stale: false };
  }

  override async getSnapshot(options?: { signal?: AbortSignal }) {
    const snapshot = await super.getSnapshot(options);
    snapshot.adapterKind = "native";
    return snapshot;
  }
}

class MobileFixtureEventsClient extends FixtureEventsClient {
  override getConnectionState() {
    return { attempt: 0, phase: "connected" as const, stale: false };
  }

  override async getSnapshot() {
    const snapshot = await super.getSnapshot();
    snapshot.adapterKind = "native";
    return snapshot;
  }
}

export async function resolveMobileStartup(
  dependencies: MobileBootstrapDependencies = defaultDependencies,
): Promise<StartupStatusClient> {
  const fixture = MobileFixtureBootstrapSchema.parse(await dependencies.invokeBootstrap());
  const mobileVpnSnapshot = await dependencies.mobileVpnClient.initialize();
  const settingsClient = new FixtureSettingsClient();
  return {
    client: new MobileFixtureStatusClient(fixture),
    dispose: () => dependencies.mobileVpnClient.dispose(),
    eventsClient: new MobileFixtureEventsClient(),
    localBackupClient: new UnavailableLocalBackupClient(),
    mobileFixture: fixture,
    mobileVpnClient: dependencies.mobileVpnClient,
    mobileVpnSnapshot,
    profileClient: new FixtureProfileClient(),
    runtime: "mobile",
    settingsClient,
    settingsSnapshot: await settingsClient.getSnapshot(),
    supportBundleClient: new UnavailableSupportBundleClient(),
    trafficClient: new MobileFixtureTrafficClient(),
  };
}
