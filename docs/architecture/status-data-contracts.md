# Status Data Contracts

## Scope

This document defines the data semantics behind Status. It separates direct
Mihomo core observations, local-bridge state, and derived product values so the UI
does not accidentally present a heuristic as core truth.

The shared TypeScript DTO, command, and runtime schemas live in
`packages/contracts`. Zod 4 validates untrusted RPC results and notifications
before an adapter can publish them to application state. The schemas preserve
the established Status view shape while distinguishing `fixture` and `rpc`
snapshot sources.

`adapterKind` distinguishes `fixture`, desktop/browser `rpc`, and mobile
`native` snapshots. It describes the Status adapter that confirmed the view,
not the language used to implement Mihomo. Stale-state UI applies to every
non-fixture adapter.

## DTO families

| DTO                       | Required meaning                                                                             | Authority                                    |
| ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `RuntimeStatusDto`        | Core lifecycle, capture selection, confirmed System Proxy and TUN state, error or transition | Local bridge plus platform adapter           |
| `TrafficSnapshotDto`      | Current up/down rates and cumulative up/down bytes                                           | Mihomo traffic stream                        |
| `RuntimeMetricsDto`       | Memory in use, uptime, active connections, effective rules                                   | Mihomo observations plus local-bridge uptime |
| `ProfileSummaryDto`       | Stable profile ID/fingerprint and user-facing label                                          | Local bridge persistence                     |
| `PolicyGroupDto`          | Opaque group label, type, children, selected child, latency data                             | Mihomo proxy tree plus delay observations    |
| `GroupUsageDto`           | Profile-scoped cumulative deduplicated connection observations                               | Local-bridge derivation                      |
| `ServiceMonitorDto`       | ID, opaque title, URL, icon key, probe policy                                                | Local bridge persistence                     |
| `ServiceProbeResultDto`   | Monitor ID, latency, timestamp, status, explicit route target                                | Local-bridge probe execution                 |
| `PlatformCapabilitiesDto` | Supported capture modes, tray, vibrancy, and other native capabilities                       | Platform adapter                             |

User-authored Mihomo labels are opaque Unicode strings. Production code must
not split, normalize, reorder, or infer structured emoji and text fields. The
current sketch keeps separate fixture properties only for convenient mock
construction; that shape is not a production contract.

The current command contracts cover snapshot reads, capture and routing-mode
changes, active-profile selection, group-scoped child selection, service-monitor
mutations, and Status subscription lifecycle. Every command returns a newly
confirmed `StatusSnapshotDto`; a JSON-RPC success envelope with an invalid result
is a validation failure, not command success. RPC snapshots must identify their
adapter kind as `rpc`, while fixture snapshots remain explicitly `fixture`.

`status.subscribe` returns both the subscription ID and a current validated
snapshot. The server resets that socket's lifecycle-event cursor before reading
the snapshot, then sends the subscription response before it can send a
notification for the new subscription. This creates an ordering barrier: events
older than the snapshot are discarded, while an event racing after the snapshot
is delivered after the response. The Status adapter applies the response snapshot
on every initial subscription and resubscription, and clears stale state only
after contract validation succeeds. A reconnect therefore becomes authoritative
without depending on a later lifecycle change. This response-shape change is
bridge protocol version 2.

Capture selection is device-level intent and is distinct from confirmed runtime
state. The capture command carries the complete selection plus an aggregate
active flag. Stopping may therefore disable both runtime paths without erasing
the selection, while starting can restore the complete remembered combination.

The shared desktop-bridge contract also defines `BridgeInfoDto` and
`CoreStatusDto`.
`CoreStatusDto` reports a closed lifecycle phase plus optional PID, version, and
error. Core lifecycle commands intentionally take an empty parameter object:
the bridge process owns executable and configuration paths, so an authenticated
browser cannot redirect process execution to an arbitrary path.

The Rust `CoreRuntime` interface mirrors these lifecycle semantics without
depending on JSON-RPC. Its typed `unavailable`, `start-failed`, and
`stop-failed` outcomes are mapped by the desktop transport and can be mapped by
future Kotlin or Swift adapters without parsing English error text.
`MishRuntime` also attaches a transport-neutral status-event sink to the core
adapter. Desktop child-process monitoring and future embedded mobile adapters can
report lifecycle changes that occur outside an explicit start or stop command
through the same runtime event stream.

## Mihomo core source mapping

| Product value                       | Mihomo source                                            | Notes                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current rates and totals            | `/traffic` stream (`up`, `down`, `upTotal`, `downTotal`) | The UI formats units; totals reset when their upstream source resets.                                                                                  |
| Memory in use                       | `/memory` stream (`inuse`)                               | Present as Mihomo memory, not total app memory.                                                                                                        |
| Active connections                  | `/connections` snapshot or stream                        | Count live connection records, not historical observations.                                                                                            |
| Policy groups and selected children | `/proxies`                                               | Preserve nested group structure and group-scoped selection.                                                                                            |
| Select a group child                | `PUT /proxies/{group}` with a child name                 | Validate the child still belongs to the group.                                                                                                         |
| Proxy or group delay                | `GET /proxies/{name}/delay` with bounded URL and timeout | The result is scoped to the requested proxy or group.                                                                                                  |
| Rules                               | `/rules`                                                 | Exclude entries explicitly marked disabled when presenting an effective count. Do not assume every implementation exposes identical disabled metadata. |
| Routing mode                        | `/configs` read/update                                   | Represent Rule, Global, and Direct as a closed product enum.                                                                                           |

Mihomo APIs can vary across versions. Pin the supported core revision and
validate response schemas at the local-bridge boundary rather than leaking version
differences into React components.

## Most-used group derivation

Mihomo does not expose a canonical primary policy group. Status therefore ranks
groups from observed usage:

1. Build the set of visible group names from the active profile's proxy tree.
2. Observe connection snapshots and process each connection ID only once for
   cumulative ranking purposes.
3. Intersect the connection's chain with known visible group names.
4. Increment every traversed group, not only the last chain element.
5. Persist counts under a stable profile fingerprint so profiles never share
   ranking history.
6. Sort descending, apply a stable tie-breaker, and show the first five groups.

Counts are heuristic ranking input. They are not exact request totals, billing
data, or a user-facing metric. The local bridge should define retention, reset,
and profile-deletion behavior before production release.

## Service probes

Service monitors are executed by the local bridge, not directly by the WebView.
This avoids browser CORS behavior, keeps results consistent between browser and
Tauri clients, and makes route selection explicit.

Use `GET` against a small or `204` endpoint as the default probe. `HEAD` may be
offered as an advanced option because some servers handle it differently from
real traffic or reject it entirely. `OPTIONS` is not a latency-probe default; it
describes supported request semantics and is often affected by CORS or server
configuration.

Each probe policy should define:

- HTTP method (`GET` by default, optionally `HEAD`);
- timeout and redirect limit;
- accepted status range or expected status;
- maximum response bytes read before cancellation;
- explicit direct, proxy, or group-scoped route target; and
- interval, backoff, and concurrency limits.

Validate URLs as HTTP or HTTPS and protect the local machine from unintended
access to loopback, link-local, metadata, or private-network targets unless the
user has explicitly enabled a trusted local-monitor use case. Store errors as
typed outcomes such as timeout, DNS failure, TLS failure, rejected status, or
policy rejection rather than converting all failures to a synthetic latency.

## Mock boundary

The current `sketch/` values, profile names, labels, connection counts, traffic,
memory, rules, latencies, and service results are fixtures. UI interactions may
change local React state, but they do not call Mihomo. Production work must
replace fixtures at a DTO boundary rather than importing core response objects
directly into components.

`packages/mock-bridge` is a separate contract-test implementation. Unlike the
in-process production fixture, it exercises real JSON-RPC serialization,
authentication, WebSocket delivery, subscriptions, and remote failures. Its
`fixture-only` capability values and deterministic measurements must not be
presented as Mihomo or operating-system observations.

## References

- [Mihomo controller API](https://wiki.metacubex.one/en/api/)
- [Mihomo proxy groups](https://wiki.metacubex.one/en/config/proxy-groups/)
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
