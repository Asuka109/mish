import {
  RpcCompatibilityError,
  RpcDisconnectedError,
  RpcDisposedError,
  type RpcConnectionState,
} from "@mish/rpc-client";
import { describe, expect, it } from "vitest";
import { FixtureEventsClient } from "./fixture-events-client";
import { FixtureNotificationClient } from "./fixture-notification-client";
import { FixtureProfileClient } from "./fixture-profile-client";
import { FixtureStatusClient } from "./fixture-status-client";
import { FixtureTrafficClient } from "./fixture-traffic-client";
import { RpcEventsClient } from "./rpc-events-client";
import { RpcNotificationClient } from "./rpc-notification-client";
import { RpcProfileClient } from "./rpc-profile-client";
import { RpcStatusClient } from "./rpc-status-client";
import { RpcTrafficClient } from "./rpc-traffic-client";
import { RpcUpdaterClient } from "./rpc-updater-client";
import {
  projectRpcClientFailure,
  projectRpcConnectionState,
  type WebRpcTransport,
} from "./web-rpc-transport";

class IncompatibleRpc {
  constructor(private readonly state: RpcConnectionState) {}

  dispose() {}

  getConnectionState() {
    return { ...this.state };
  }

  onNotification() {
    return () => undefined;
  }

  request() {
    return Promise.reject(
      new RpcCompatibilityError(
        this.state.phase as "client-too-old" | "backend-too-old",
        `Protocol ${this.state.phase}`,
      ),
    );
  }

  subscribeConnection(listener: (state: RpcConnectionState) => void) {
    listener(this.getConnectionState());
    return () => undefined;
  }
}

describe("RPC compatibility product projections", () => {
  it.each(["client-too-old", "backend-too-old"] as const)(
    "projects %s identically while leaving domain clients separate",
    async (phase) => {
      const rpc = new IncompatibleRpc({ attempt: 0, phase, stale: true }) as WebRpcTransport;
      const clients = [
        new RpcStatusClient(rpc),
        new RpcTrafficClient(rpc),
        new RpcProfileClient(rpc, null),
        new RpcEventsClient(rpc),
        new RpcNotificationClient(rpc),
        new RpcUpdaterClient(rpc),
      ];
      expect(clients.map((client) => client.getConnectionState())).toEqual(
        clients.map(() => ({ attempt: 0, phase, stale: true })),
      );
    },
  );

  it("projects transport setup and reconnect phases through one stale connection model", () => {
    expect(
      ["connecting", "authenticating", "negotiating"].map((phase) =>
        projectRpcConnectionState({
          attempt: 2,
          phase: phase as "authenticating" | "connecting" | "negotiating",
          stale: false,
        }),
      ),
    ).toEqual([
      { attempt: 2, phase: "connecting", stale: true },
      { attempt: 2, phase: "connecting", stale: true },
      { attempt: 2, phase: "connecting", stale: true },
    ]);
    expect(projectRpcConnectionState({ attempt: 3, phase: "reconnecting", stale: true })).toEqual({
      attempt: 3,
      phase: "reconnecting",
      stale: true,
    });
  });

  it("maps compatibility and transport availability failures once", () => {
    expect(
      projectRpcClientFailure(new RpcCompatibilityError("client-too-old", "Upgrade app")),
    ).toMatchObject({ code: "protocol", message: "Upgrade app", retryable: false });
    expect(
      projectRpcClientFailure(new RpcCompatibilityError("backend-too-old", "Upgrade backend")),
    ).toMatchObject({ code: "protocol", message: "Upgrade backend", retryable: false });
    expect(projectRpcClientFailure(new RpcDisconnectedError("Backend unavailable"))).toEqual({
      code: "disconnected",
      message: "Backend unavailable",
      retryable: true,
    });
    expect(projectRpcClientFailure(new RpcDisposedError())).toMatchObject({
      code: "disconnected",
      retryable: true,
    });
  });

  it("keeps fixture connection authority outside the Web RPC transport projection", () => {
    const fixtures = [
      new FixtureStatusClient(),
      new FixtureTrafficClient(),
      new FixtureProfileClient(),
      new FixtureEventsClient(),
      new FixtureNotificationClient(),
    ];
    expect(fixtures.map((client) => client.getConnectionState())).toEqual(
      fixtures.map(() => ({ attempt: 0, phase: "fixture", stale: false })),
    );
  });
});
