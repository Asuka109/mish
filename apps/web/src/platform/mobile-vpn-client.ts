import {
  MobileVpnEventSchema,
  MobileVpnSnapshotSchema,
  type MobileVpnSnapshotDto,
} from "@mish/contracts";
import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";

interface MobileVpnTransport {
  invoke(command: string): Promise<unknown>;
  listen(handler: (payload: unknown) => void): Promise<PluginListener>;
}

export interface MobileVpnClient {
  dispose(): void;
  getSnapshot(): MobileVpnSnapshotDto | undefined;
  initialize(): Promise<MobileVpnSnapshotDto>;
  requestNotificationPermission(): Promise<MobileVpnSnapshotDto>;
  requestVpnConsent(): Promise<MobileVpnSnapshotDto>;
  startFixtureLifecycle(): Promise<MobileVpnSnapshotDto>;
  stop(): Promise<MobileVpnSnapshotDto>;
  subscribe(handler: (snapshot: MobileVpnSnapshotDto) => void): () => void;
}

const defaultTransport: MobileVpnTransport = {
  invoke: (command) => invoke(`plugin:mish-vpn|${command}`),
  listen: (handler) => addPluginListener("mish-vpn", "snapshot", handler),
};

export class MobileVpnFixtureClient implements MobileVpnClient {
  private listener?: PluginListener;
  private snapshot?: MobileVpnSnapshotDto;
  private readonly subscribers = new Set<(snapshot: MobileVpnSnapshotDto) => void>();

  constructor(private readonly transport: MobileVpnTransport = defaultTransport) {}

  async initialize(): Promise<MobileVpnSnapshotDto> {
    if (!this.listener) {
      this.listener = await this.transport.listen((payload) => {
        const event = MobileVpnEventSchema.parse(payload);
        this.acceptSnapshot(event.snapshot);
      });
    }
    return this.runCommand("get_snapshot");
  }

  getSnapshot(): MobileVpnSnapshotDto | undefined {
    return this.snapshot;
  }

  requestNotificationPermission(): Promise<MobileVpnSnapshotDto> {
    return this.runCommand("request_notification_permission");
  }

  requestVpnConsent(): Promise<MobileVpnSnapshotDto> {
    return this.runCommand("request_vpn_consent");
  }

  startFixtureLifecycle(): Promise<MobileVpnSnapshotDto> {
    return this.runCommand("start_fixture_lifecycle");
  }

  stop(): Promise<MobileVpnSnapshotDto> {
    return this.runCommand("stop");
  }

  subscribe(handler: (snapshot: MobileVpnSnapshotDto) => void): () => void {
    this.subscribers.add(handler);
    if (this.snapshot) handler(this.snapshot);
    return () => this.subscribers.delete(handler);
  }

  dispose(): void {
    void this.listener?.unregister().catch(() => undefined);
    this.listener = undefined;
    this.subscribers.clear();
  }

  private async runCommand(command: string): Promise<MobileVpnSnapshotDto> {
    const snapshot = MobileVpnSnapshotSchema.parse(await this.transport.invoke(command));
    this.acceptSnapshot(snapshot);
    return this.snapshot ?? snapshot;
  }

  private acceptSnapshot(snapshot: MobileVpnSnapshotDto): void {
    if (this.snapshot && snapshot.sequence <= this.snapshot.sequence) return;
    this.snapshot = snapshot;
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }
}
