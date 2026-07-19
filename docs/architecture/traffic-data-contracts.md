# Traffic Data Contracts

## Scope

Traffic uses an independent snapshot and subscription contract. Detailed
connections and effective rules do not belong in the compact `StatusSnapshot`.
The same contract is consumed by the browser fixture, desktop RPC adapter, and
future native adapters without exposing Mihomo Controller JSON directly to
React.

The first production slice is read-only. It supports Active, recently Closed,
and Rules investigation, but it deliberately defines no close-one or close-all
RPC method. Disabled UI controls explain this boundary and never send a
substitute command.

## Snapshot shape

`TrafficDataSnapshotDto` contains:

- adapter kind and active profile ID;
- observation phase, monotonic sequence, session ID, and reconnect count;
- a bounded current active-connection collection; and
- an ordered effective-rule collection.

Each connection preserves the Controller connection ID, destination host/IP and
port, optional remote and sniff destinations, source IP and port, optional
process name and path, network and inbound protocol, start time, exact upload
and download byte counters, matched rule type and payload, provider chain, and
complete ordered route chain. Empty Controller process or address strings map to
explicit nullable fields. The UI labels null values unavailable rather than
inventing process identity, geography, or another fallback fact.

Connection byte counters are decimal strings. Mihomo exposes signed 64-bit
values; the mapper rejects negatives transactionally and serializes valid values
without losing precision in JavaScript. Sorting uses exact integer comparison.

Each rule preserves its zero-based priority, type, payload, target, enabled
state, size, and optional hit metadata. Disabled rules remain inspectable and
are visually distinguished. Their presence does not increase Status's effective
rule count.

## Sequence, reconnect, and stale semantics

Traffic observation has three phases:

| Phase         | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `unavailable` | No Controller-backed Traffic source is configured; active and rule collections are empty.    |
| `ready`       | A complete Controller session established current connections and rules.                     |
| `stale`       | A previously ready session has an observation gap; its retained rows are not current Active. |

The Controller source increments `sequence` after every accepted connection or
rule refresh. A successful complete initial observation creates a new
`sessionId`; a reconnect creates another ID and increments `reconnectCount`.
Session and refresh failures mark Traffic stale immediately. A later complete
initial batch is required to restore ready state.

`traffic.subscribe` returns `{ subscriptionId, snapshot }`. The bridge resets
the socket event cursor before sampling and sends the response before later
notifications, matching the Status subscription ordering barrier. The RPC
adapter also marks Traffic stale as soon as its transport disconnects. It does
not continue presenting the last active rows as current while reconnecting.

Desktop profile activation replaces the shared runtime host only after the
candidate's first valid Traffic and Status observations and active-state commit.
Traffic subscriptions reset and resample that authoritative runtime on profile
change, so rows from a prior profile cannot be presented under the new active
profile context.

## Recently Closed derivation

Recently Closed is local, in-memory diagnostic context derived by diffing
successive ready Active snapshots from the same session:

1. Record the first ready snapshot as a baseline without inferring closure.
2. For a higher sequence in the same session, move missing prior IDs into the
   local Closed collection using their last observed fields.
3. Invalidate the baseline on RPC stale state, a stale/unavailable snapshot, or
   a session-ID change.
4. Never infer that rows missing across a reconnect gap closed normally.

The default retention is the newest 512 rows for at most 30 minutes. The
collection is not persisted and is not a durable, accounting, or billing-grade
ledger. Clear Closed affects only this local collection. It does not mutate
Mihomo, active connections, profiles, rules, configuration, or logs.

## Filtering, sorting, and rendering

Plain text searches destination, process, rule, and route-chain values.
Structured tokens compose with plain text: `destination:`, `process:`, `rule:`,
`chain:`, `group:`, `child:`, `network:`, `protocol:`, and `state:`. Network is
also available as a structured select. Rules accept `type:`, `payload:`,
`target:`, and `enabled:`.

All sorts use an explicit stable input-order tie-breaker. Active and Closed can
sort by start time, destination, exact downloaded bytes, or exact uploaded
bytes. Rules can sort by priority, type, target, or exact hit count. The UI
sorts and filters the complete bounded snapshot, then renders 250 rows per
incremental batch so large valid snapshots do not create an unbounded initial
DOM.

## Privacy and fixture policy

Destination names, source and destination IPs, process names, and local paths
remain inside the local browser/WebView and desktop bridge. This slice has no
copy, export, telemetry, or upload action. Future disclosure actions require an
explicit scope and structured redaction design.

Browser fixtures use only reserved `.invalid` names, documentation address
ranges, synthetic process names, and `/synthetic/` paths. Fixtures perform no
network or system operation and must never be described as Controller success.
