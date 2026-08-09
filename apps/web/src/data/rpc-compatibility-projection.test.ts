import { mishRpcMethods } from "@mish/contracts";
import { RpcClient, RpcCompatibilityError, type RpcConnectionState } from "@mish/rpc-client";
import { describe, expect, it } from "vitest";
import { RpcEventsClient } from "./rpc-events-client";
import { RpcNotificationClient } from "./rpc-notification-client";
import { RpcProfileClient } from "./rpc-profile-client";
import { RpcSettingsClient } from "./rpc-settings-client";
import { RpcStatusClient } from "./rpc-status-client";
import { RpcTrafficClient } from "./rpc-traffic-client";
import { RpcUpdaterClient } from "./rpc-updater-client";

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
      const rpc = new IncompatibleRpc({ attempt: 0, phase, stale: true }) as unknown as RpcClient<
        typeof mishRpcMethods
      >;
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

      const settings = new RpcSettingsClient(rpc);
      await expect(settings.getSnapshot()).rejects.toMatchObject({
        name: "RpcCompatibilityError",
        outcome: phase,
      });
    },
  );
});
