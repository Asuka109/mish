import {
  TrafficClientError,
  type EffectiveRuleDto,
  type TrafficClient,
  type TrafficConnectionDto,
  type TrafficConnectionState,
  type TrafficDataSnapshotDto,
} from "@mish/contracts";

const fixtureConnections: TrafficConnectionDto[] = [
  createConnection({
    destinationHost: "docs.fixture.invalid",
    destinationIp: "198.51.100.21",
    destinationPort: 443,
    downloadBytes: "1483200",
    id: "fixture-connection-1",
    network: "tcp",
    processName: "Fixture Browser",
    processPath: "/synthetic/apps/fixture-browser",
    protocol: "HTTP",
    rulePayload: "fixture.invalid",
    ruleType: "DomainSuffix",
    routeChain: ["Fixture Policy", "Fixture Relay", "Fixture Exit"],
    uploadBytes: "48120",
  }),
  createConnection({
    destinationHost: "media.fixture.invalid",
    destinationIp: "203.0.113.42",
    destinationPort: 443,
    downloadBytes: "26849024",
    id: "fixture-connection-2",
    network: "udp",
    processName: "Fixture Player",
    processPath: "/synthetic/apps/fixture-player",
    protocol: "TUN",
    rulePayload: "media.fixture.invalid",
    ruleType: "Domain",
    routeChain: ["Fixture Media", "Fixture Auto", "Fixture Exit B"],
    uploadBytes: "382020",
  }),
  createConnection({
    destinationHost: null,
    destinationIp: "192.0.2.84",
    destinationPort: 53,
    downloadBytes: "842",
    id: "fixture-connection-3",
    network: "udp",
    processName: null,
    processPath: null,
    protocol: "TUN",
    rulePayload: "192.0.2.0/24",
    ruleType: "IPCIDR",
    routeChain: ["Fixture Direct"],
    uploadBytes: "394",
  }),
  createConnection({
    destinationHost: "api.fixture.invalid",
    destinationIp: "198.51.100.64",
    destinationPort: 8443,
    downloadBytes: "92318",
    id: "fixture-connection-4",
    network: "tcp",
    processName: "Fixture CLI",
    processPath: "/synthetic/bin/fixture-cli",
    protocol: "SOCKS5",
    rulePayload: "Fixture CLI",
    ruleType: "ProcessName",
    routeChain: ["Fixture Development", "Fixture Exit"],
    uploadBytes: "18842",
  }),
  createConnection({
    destinationHost: "chat.fixture.invalid",
    destinationIp: "203.0.113.92",
    destinationPort: 443,
    downloadBytes: "498210",
    id: "fixture-connection-5",
    network: "tcp",
    processName: "Fixture Chat",
    processPath: null,
    protocol: "HTTP",
    rulePayload: "chat.fixture.invalid",
    ruleType: "Domain",
    routeChain: ["Fixture Messaging", "Fixture Exit B"],
    uploadBytes: "72091",
  }),
  createConnection({
    destinationHost: "assets.fixture.invalid",
    destinationIp: "192.0.2.112",
    destinationPort: 80,
    downloadBytes: "18429",
    id: "fixture-connection-6",
    network: "tcp",
    processName: "Fixture Updater",
    processPath: "/synthetic/apps/fixture-updater",
    protocol: "REDIR",
    rulePayload: "assets.fixture.invalid",
    ruleType: "Domain",
    routeChain: ["Fixture Direct"],
    uploadBytes: "3190",
  }),
];

const fixtureRules: EffectiveRuleDto[] = [
  createRule(0, "ProcessName", "Fixture CLI", "Fixture Development", true, "8"),
  createRule(1, "Domain", "media.fixture.invalid", "Fixture Media", true, "19"),
  createRule(2, "Domain", "chat.fixture.invalid", "Fixture Messaging", true, "6"),
  createRule(3, "DomainSuffix", "fixture.invalid", "Fixture Policy", true, "42"),
  createRule(4, "IPCIDR", "192.0.2.0/24", "Fixture Direct", true, "3"),
  createRule(5, "Network", "udp", "Fixture Auto", false, "0"),
  createRule(6, "Domain", "unused.fixture.invalid", "Fixture Reject", false, "0"),
  createRule(7, "Match", "", "Fixture Policy", true, "101"),
];

const initialSnapshot: TrafficDataSnapshotDto = {
  activeConnections: fixtureConnections,
  adapterKind: "fixture",
  phase: "ready",
  profileId: "fixture-profile",
  reconnectCount: 0,
  rules: fixtureRules,
  sequence: 1,
  sessionId: "fixture-session",
};

interface ConnectionFixture {
  destinationHost: string | null;
  destinationIp: string;
  destinationPort: number;
  downloadBytes: string;
  id: string;
  network: string;
  processName: string | null;
  processPath: string | null;
  protocol: string;
  routeChain: string[];
  rulePayload: string;
  ruleType: string;
  uploadBytes: string;
}

function createConnection(fixture: ConnectionFixture): TrafficConnectionDto {
  return {
    destinationHost: fixture.destinationHost,
    destinationIp: fixture.destinationIp,
    destinationPort: fixture.destinationPort,
    downloadBytes: fixture.downloadBytes,
    id: fixture.id,
    matchedRule: { payload: fixture.rulePayload, type: fixture.ruleType },
    network: fixture.network,
    processName: fixture.processName,
    processPath: fixture.processPath,
    protocol: fixture.protocol,
    providerChain: [],
    remoteDestination: null,
    routeChain: fixture.routeChain,
    sniffHost: null,
    sourceIp: "192.0.2.10",
    sourcePort: 50_000 + Number(fixture.id.at(-1)),
    startedAt: `2026-01-01T00:0${Number(fixture.id.at(-1))}:00Z`,
    uploadBytes: fixture.uploadBytes,
  };
}

function createRule(
  priority: number,
  type: string,
  payload: string,
  target: string,
  enabled: boolean,
  hitCount: string,
): EffectiveRuleDto {
  return {
    enabled,
    hitCount,
    lastHitAt: enabled ? "2026-01-01T00:10:00Z" : null,
    payload,
    priority,
    size: "-1",
    target,
    type,
  };
}

export class FixtureTrafficClient implements TrafficClient {
  private readonly connectionListeners = new Set<(state: TrafficConnectionState) => void>();
  private readonly snapshotListeners = new Set<(snapshot: TrafficDataSnapshotDto) => void>();
  private snapshot = structuredClone(initialSnapshot);
  private disposed = false;

  dispose() {
    this.disposed = true;
    this.connectionListeners.clear();
    this.snapshotListeners.clear();
  }

  getConnectionState(): TrafficConnectionState {
    return { attempt: 0, phase: this.disposed ? "disposed" : "fixture", stale: false };
  }

  async getSnapshot(options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) throw new TrafficClientError("cancelled", "Request cancelled");
    if (this.disposed) throw new TrafficClientError("disconnected", "Traffic client disposed");
    return structuredClone(this.snapshot);
  }

  publishSnapshot(snapshot: TrafficDataSnapshotDto) {
    this.snapshot = structuredClone(snapshot);
    for (const listener of this.snapshotListeners) listener(structuredClone(snapshot));
  }

  subscribeConnection(listener: (state: TrafficConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  subscribeSnapshots(listener: (snapshot: TrafficDataSnapshotDto) => void) {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }
}

export function createFixtureTrafficClient() {
  return new FixtureTrafficClient();
}
