import type {
  EffectiveRuleDto,
  TrafficConnectionDto,
  TrafficDataSnapshotDto,
} from "@mish/contracts";

export const CLOSED_CONNECTION_LIMIT = 512;
export const CLOSED_CONNECTION_MAX_AGE_MILLISECONDS = 30 * 60 * 1_000;
export const TRAFFIC_RENDER_BATCH_SIZE = 250;

export interface ClosedTrafficConnection extends TrafficConnectionDto {
  closedAt: string;
}

interface ActiveBaseline {
  connections: Map<string, TrafficConnectionDto>;
  sequence: number;
  sessionId: string;
}

export interface TrafficHistoryState {
  baseline: ActiveBaseline | null;
  closed: ClosedTrafficConnection[];
}

export interface TrafficRetentionPolicy {
  maxAgeMilliseconds: number;
  maxEntries: number;
}

export type ConnectionSort = "started-desc" | "destination-asc" | "download-desc" | "upload-desc";
export type RuleSort = "priority-asc" | "type-asc" | "target-asc" | "hits-desc";

const defaultRetention: TrafficRetentionPolicy = {
  maxAgeMilliseconds: CLOSED_CONNECTION_MAX_AGE_MILLISECONDS,
  maxEntries: CLOSED_CONNECTION_LIMIT,
};

export function createTrafficHistoryState(): TrafficHistoryState {
  return { baseline: null, closed: [] };
}

export function clearClosedHistory(state: TrafficHistoryState): TrafficHistoryState {
  return { ...state, closed: [] };
}

export function reconcileTrafficSnapshot(
  state: TrafficHistoryState,
  snapshot: TrafficDataSnapshotDto,
  now = new Date(),
  retention: TrafficRetentionPolicy = defaultRetention,
): TrafficHistoryState {
  const closed = pruneClosed(state.closed, now, retention);
  if (snapshot.phase !== "ready" || snapshot.sessionId === null) {
    return { baseline: null, closed };
  }

  const nextBaseline = createBaseline(snapshot);
  if (!state.baseline || state.baseline.sessionId !== snapshot.sessionId) {
    return { baseline: nextBaseline, closed };
  }
  if (snapshot.sequence <= state.baseline.sequence) {
    return { baseline: state.baseline, closed };
  }

  const activeIds = new Set(snapshot.activeConnections.map((connection) => connection.id));
  const closedAt = now.toISOString();
  const newlyClosed = [...state.baseline.connections.values()]
    .filter((connection) => !activeIds.has(connection.id))
    .map((connection) => ({ ...connection, closedAt }));
  return {
    baseline: nextBaseline,
    closed: pruneClosed([...newlyClosed, ...closed], now, retention),
  };
}

export function filterConnections<T extends TrafficConnectionDto>(
  connections: readonly T[],
  query: string,
  state: "active" | "closed",
  network: string,
): T[] {
  const tokens = parseQuery(query);
  return connections.filter((connection) => {
    if (network !== "all" && connection.network.toLocaleLowerCase() !== network) return false;
    return tokens.every((token) => matchesConnectionToken(connection, state, token));
  });
}

export function filterRules(rules: readonly EffectiveRuleDto[], query: string): EffectiveRuleDto[] {
  const tokens = parseQuery(query);
  return rules.filter((rule) => tokens.every((token) => matchesRuleToken(rule, token)));
}

export function sortConnections<T extends TrafficConnectionDto>(
  connections: readonly T[],
  sort: ConnectionSort,
  locale: string,
): T[] {
  return stableSort(connections, (left, right) => {
    if (sort === "download-desc") {
      return compareDecimal(right.downloadBytes, left.downloadBytes);
    }
    if (sort === "upload-desc") return compareDecimal(right.uploadBytes, left.uploadBytes);
    if (sort === "destination-asc") {
      return destinationLabel(left).localeCompare(destinationLabel(right), locale, {
        numeric: true,
        sensitivity: "base",
      });
    }
    return Date.parse(right.startedAt) - Date.parse(left.startedAt);
  });
}

export function sortRules(
  rules: readonly EffectiveRuleDto[],
  sort: RuleSort,
  locale: string,
): EffectiveRuleDto[] {
  return stableSort(rules, (left, right) => {
    if (sort === "hits-desc") {
      return compareDecimal(right.hitCount ?? "0", left.hitCount ?? "0");
    }
    if (sort === "type-asc") {
      return left.type.localeCompare(right.type, locale, { numeric: true, sensitivity: "base" });
    }
    if (sort === "target-asc") {
      return left.target.localeCompare(right.target, locale, {
        numeric: true,
        sensitivity: "base",
      });
    }
    return left.priority - right.priority;
  });
}

export function destinationLabel(connection: TrafficConnectionDto) {
  return (
    connection.destinationHost ??
    connection.sniffHost ??
    connection.remoteDestination ??
    connection.destinationIp ??
    ""
  );
}

interface QueryToken {
  field: string | null;
  value: string;
}

function createBaseline(snapshot: TrafficDataSnapshotDto): ActiveBaseline {
  return {
    connections: new Map(
      snapshot.activeConnections.map((connection) => [connection.id, structuredClone(connection)]),
    ),
    sequence: snapshot.sequence,
    sessionId: snapshot.sessionId ?? "",
  };
}

function pruneClosed(
  connections: readonly ClosedTrafficConnection[],
  now: Date,
  retention: TrafficRetentionPolicy,
) {
  const cutoff = now.getTime() - retention.maxAgeMilliseconds;
  return connections
    .filter((connection) => Date.parse(connection.closedAt) >= cutoff)
    .slice(0, retention.maxEntries);
}

function parseQuery(query: string): QueryToken[] {
  return query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((raw) => {
      const separator = raw.indexOf(":");
      if (separator <= 0) return { field: null, value: raw.toLocaleLowerCase() };
      return {
        field: raw.slice(0, separator).toLocaleLowerCase(),
        value: raw.slice(separator + 1).toLocaleLowerCase(),
      };
    })
    .filter((token) => token.value.length > 0);
}

function matchesConnectionToken(
  connection: TrafficConnectionDto,
  state: "active" | "closed",
  token: QueryToken,
) {
  const destination = [
    connection.destinationHost,
    connection.destinationIp,
    connection.remoteDestination,
    connection.sniffHost,
    String(connection.destinationPort),
  ];
  const process = [connection.processName, connection.processPath];
  const providerChain = connection.providerChain;
  const rule = [connection.matchedRule.type, connection.matchedRule.payload];
  const routeChain = connection.routeChain;
  const fields: Record<string, Array<string | null>> = {
    chain: routeChain,
    child: routeChain,
    destination,
    group: routeChain,
    network: [connection.network],
    process,
    provider: providerChain,
    protocol: [connection.protocol],
    rule,
    state: [state],
  };
  const values = token.field
    ? fields[token.field]
    : [...destination, ...process, ...rule, ...routeChain, ...providerChain];
  if (!values) return false;
  return values.some((value) => value?.toLocaleLowerCase().includes(token.value));
}

function matchesRuleToken(rule: EffectiveRuleDto, token: QueryToken) {
  const fields: Record<string, Array<string | null>> = {
    enabled: [String(rule.enabled)],
    payload: [rule.payload],
    target: [rule.target],
    type: [rule.type],
  };
  const values = token.field ? fields[token.field] : [rule.type, rule.payload, rule.target];
  if (!values) return false;
  return values.some((value) => value?.toLocaleLowerCase().includes(token.value));
}

function compareDecimal(left: string, right: string) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue === rightValue) return 0;
  return leftValue > rightValue ? 1 : -1;
}

function stableSort<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  return values
    .map((value, index) => ({ index, value }))
    .sort((left, right) => compare(left.value, right.value) || left.index - right.index)
    .map(({ value }) => value);
}
