# Traffic Data Contracts

## Scope

Traffic uses an independent snapshot and subscription contract. Detailed
connections and effective rules do not belong in the compact `StatusSnapshot`.
The same contract is consumed by the browser fixture, desktop RPC adapter, and
future native adapters without exposing Mihomo Controller JSON directly to
React.

Traffic supports Active, recently Closed, and Rules investigation plus three
confirmed desktop commands: close one current active connection, close the
bounded stable-ID set matching the current filter, and close all connections
active in the current authoritative snapshot. All three commands are unavailable
in the browser fixture, which never reports desktop mutation success.

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

The managed desktop runtime overrides source `find-process-mode` with the
private application setting `processDiscoveryMode`. Its bounded values map
one-to-one to Mihomo `always`, `strict`, and `off`; the default is `always`, and
a change applies on the next proxy start or Profile activation. This keeps
subscription content from silently controlling local process inspection while
allowing the user to reduce or disable it explicitly. Mihomo can still omit
attribution for connection classes it cannot resolve; the UI explains that
honest unavailable state. Process strings remain bounded by Controller
validation and the local authenticated DTO boundary, and no remote, export, or
telemetry surface is added.

On supported macOS desktops, the UI may request a process icon lazily through
`traffic.getProcessIcon`. The browser supplies only a current connection ID.
Rust resolves that ID against the current authoritative Traffic snapshot and
passes its already-validated process path to the platform adapter; RPC schemas
reject a browser-supplied path, and missing or stale IDs return no icon. The
platform adapter accepts only absolute existing files, prefers the enclosing
application bundle, renders a bounded 64 × 64 PNG, and caps paths at 16 KiB and
results at 256 KiB. It keeps at most 256 positive or negative entries and 8 MiB
of PNG data. The UI deduplicates in-flight requests and keeps at most 128
successful path-keyed results. Icons therefore stay inside the same
authenticated loopback privacy boundary as process names and paths without
creating an arbitrary local-file read surface.

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
The adapter invalidates and refreshes its advertised close capabilities when
the authoritative Traffic session ID changes. An application opened while the
runtime is inactive therefore does not retain a permanently disabled command
set after a profile starts.

Desktop profile activation replaces the shared runtime host only after the
candidate's first valid Traffic and Status observations and active-state commit.
Traffic subscriptions reset and resample that authoritative runtime on profile
change, so rows from a prior profile cannot be presented under the new active
profile context.

## Confirmed connection commands

The command authority is limited to `profileId`, `sessionId`, `sequence`, and,
for targeted closes, stable Controller connection IDs already present in that
snapshot. Filtered-visible close accepts only a non-empty, unique, bounded ID
list. Destination addresses, process names, process paths, URLs, and rendered
row positions are never command authority. RPC parameter schemas reject unknown
fields.

Before mutation, the Controller source serializes commands with observation
refreshes, verifies the pinned core version, validates the authority against
the current ready snapshot, and performs a fresh `/connections` read. A
one-connection command fails as `stale-connection` when its ID has disappeared.
A filtered-visible command fails as `stale-snapshot` when any requested ID is
not in the authoritative or fresh Controller snapshot. It closes only the
revalidated IDs through Mihomo's single-connection endpoint, so unrelated
connections observed after the browser snapshot cannot be terminated.
A close-all command compares the complete fresh active-ID set with the
authoritative snapshot and fails as `stale-snapshot` if it changed before
mutation. This prevents a delayed confirmation from silently changing scope.

Mihomo v1.19.29 implements `DELETE /connections/{id}` and
`DELETE /connections`. Both handlers return `204 No Content`; the single-ID
handler also returns 204 when no tracker exists, and both handlers ignore
tracker `Close` errors. Mish therefore treats the HTTP response only as command
acceptance. It polls fresh, validated `/connections` snapshots and publishes
success only after every targeted ID disappears. These semantics are fixed by
the pinned [connection routes](https://github.com/MetaCubeX/mihomo/blob/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb/hub/route/connections.go)
and [tracker manager](https://github.com/MetaCubeX/mihomo/blob/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb/tunnel/statistic/manager.go)
source.

Every command returns a typed result containing its operation, success or
failure status, target count, any remaining target IDs, and the latest
authoritative Traffic snapshot. Typed failures distinguish unsupported,
invalid request, conflict, stale snapshot, stale connection, timeout,
disconnect, version drift, Controller rejection, runtime replacement, partial
remaining targets, and inconsistent observation. Failures refresh authority
when possible and never synthesize success from a 2xx response. The desktop
runtime host checks identity again after command reconciliation; replacement
returns `runtime-replaced` with the replacement runtime's snapshot.

“Close all active connections” always means the complete active collection in
the current profile and observation session. It is not limited by text search,
network filters, tabs, or incremental rendering. The confirmation dialog states
that scope and shows the current total. New connections created after
confirmation are not part of the confirmed target set and may remain active.
Because Mihomo's all-active endpoint operates at Controller handling time, it
may also close a connection created in the narrow interval between Mish's fresh
preflight and the DELETE request; Mish never claims that such a later ID was a
confirmed target.

“Close visible connections” means the complete filtered result set before
incremental rendering limits. The confirmation freezes and displays its exact
count. Search, network filter, and live refresh may continue; Rust revalidates
the frozen stable-ID set immediately before mutation and returns typed stale
feedback when the set can no longer be honored.

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
network or system operation, advertise both close commands as unsupported, and
must never be described as Controller success.

## Native private connection observation log

The native shell may derive one consumer-neutral route-activity summary from
the same typed `TrafficDataSnapshot`; it does not poll Controller data and does
not create another Traffic authority. The log is scoped to the active
`profileId` and `sessionId`, and resets on stale, unavailable, missing-session,
profile replacement, or Traffic-session replacement. A ready empty snapshot is
authoritative for current-active tracking but retains recent observations for a
requested rolling query.

Each first-seen connection contributes one private event containing only its
monotonic observation time and an already-resolved, display-safe terminal-node
label. Destination, address, process, route chain, profile, Controller data,
and raw connection ID are never exposed to native-menu consumers. Raw IDs are
reduced to private session-only fingerprints for deduplication; no event or
query returns an ID. Labels resembling endpoints, paths, URLs, credentials, or
controls are rejected, and accepted Unicode labels are bounded before display.
There is no persistence, export, telemetry upload, or raw native-menu
presentation in this slice.

The production ring retains 8,192 events oldest-first. Its conservative
10 MiB accounting is 8,192 × 512 B for rich event allocation (4 MiB), 131,072
× 32 B for the fingerprint index (4 MiB), plus 1,114,112 B for ring/index
containers, allocator rounding, and safety margin: 9,502,720 B total. Explicit
telemetry reports retained count, capacity, eviction count, distinct-ID count,
dedupe capacity/overflow, and current-active count. The fingerprint index is
larger than the ring so ring overflow does not make long-lived connections new
again. If its fixed session capacity is exhausted, new IDs are deliberately not
recorded and telemetry exposes the overflow; this bounded residual limit is
preferable to violating the 10 MiB privacy-memory cap. The ring promises a
capacity, never a time duration.
