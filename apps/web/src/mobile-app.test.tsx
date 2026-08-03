import type { MobileConfigValidationResultDto, MobileVpnSnapshotDto } from "@mish/contracts";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import TypesafeI18n from "./i18n/i18n-react";
import { loadAllLocales } from "./i18n/i18n-util.sync";
import { AppRoutes } from "./mobile-app";
import type { MobileVpnClient } from "./platform/mobile-vpn-client";

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

const snapshot: MobileVpnSnapshotDto = {
  activationSessionId: null,
  activeNetwork: false,
  authorityId: "mobile-app-authority",
  backendKind: "fixture",
  contractVersion: 1,
  coreAbiVersion: null,
  coreAvailability: "unavailable",
  coreRunning: false,
  coreCommit: null,
  configFailureInjectionAvailable: false,
  coreConfigState: "unloaded",
  coreVersion: null,
  coreWrapperRevision: null,
  dnsApplied: false,
  failure: null,
  foreground: false,
  loadedConfigDigest: null,
  loadedConfigRevision: null,
  message: "Fixture only.",
  notificationPermission: "required",
  operation: null,
  permission: "required",
  phase: "permission-required",
  protectedSocketCount: 0,
  publicRequestObserved: false,
  revision: 1,
  routesApplied: false,
  sequence: 1,
  sessionId: "mobile-app-test",
  updatedAtMillis: 1,
  validatedConfigDigest: null,
  validatedConfigRevision: null,
  vpnActive: false,
  vpnAvailability: "unavailable",
  tunAvailability: "unavailable",
  tunEstablished: false,
};

const vpnClient: MobileVpnClient = {
  dispose() {},
  getSnapshot: () => snapshot,
  initialize: async () => snapshot,
  loadConfig: async (_bytes, identity) => ({
    cancellation: "not-requested",
    contractVersion: 1,
    digest: identity.digest,
    failure: "core-unavailable",
    message: "The packaged Mobile Core is unavailable.",
    operationId: "mobile-app-load",
    outcome: "failed",
    revision: identity.revision,
    rollback: "unloaded",
    snapshot,
    timing: "on-time",
  }),
  requestNotificationPermission: async () => snapshot,
  requestVpnConsent: async () => snapshot,
  start: async () => snapshot,
  stop: async () => snapshot,
  subscribe: (handler) => {
    handler(snapshot);
    return () => undefined;
  },
  validateConfig: async (): Promise<MobileConfigValidationResultDto> => ({
    contractVersion: 1,
    failure: "core-unavailable",
    message: "The packaged Mobile Core is unavailable.",
    outcome: "failed",
    sequence: snapshot.sequence,
    sessionId: snapshot.sessionId,
  }),
};

describe("mobile application routes", () => {
  it("composes a dedicated Home instead of the desktop Status page", () => {
    const view = render(
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={["/status"]}>
          <AppRoutes
            mobileFixture={fixture}
            mobileVpnClient={vpnClient}
            mobileVpnSnapshot={snapshot}
          />
        </MemoryRouter>
      </TypesafeI18n>,
    );

    expect(screen.getByRole("heading", { name: "VPN permission required" })).toBeVisible();
    expect(view.container.querySelector(".mobile-home-page")).not.toBeNull();
    expect(view.container.querySelector(".status-page")).toBeNull();
    expect(view.container.querySelector(".workspace-page-scroll")).toBeNull();
    expect(view.container.querySelector(".sidebar")).toBeNull();
  });
});
