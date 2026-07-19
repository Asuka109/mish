# Events Data Contracts

## Scope

Events uses an independent snapshot and subscription contract. Event rows do
not belong in the compact Status snapshot and do not share Traffic retention.
The same transport-neutral contract is consumed by the browser fixture, desktop
RPC adapter, and future native adapters.

This P0 slice is read-only. It exposes a bounded local view and one safe-copy
action for a single already-redacted event. It defines no diagnostic export,
upload, arbitrary file read, telemetry, core stop, or core mutation command.

## Snapshot shape

`EventsSnapshotDto` contains:

- adapter kind and active profile ID;
- observation phase, monotonic sequence, session ID, and reconnect count;
- at most 1,024 current-session event records; and
- explicit availability for application, core, RPC, and platform sources.

Each event has a stable session-scoped ID, sequence, local receipt timestamp,
severity, source, concise message, and optional detail. Severity is the closed
set Debug, Info, Warning, and Error. Source is the closed set Application,
Core, RPC, and Platform.

The desktop Controller adapter currently supplies redacted Mihomo core logs and
application-owned session-boundary observations. RPC request tracing and
platform-adapter events are explicitly unavailable. Browser values are marked
`fixture` and every source is marked `fixture-only`; they are never presented as
desktop observations.

## Sequence, reconnect, and runtime replacement

Events observation has four phases:

| Phase         | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `unavailable` | The runtime has no Events data source.                                 |
| `connecting`  | A Controller source exists but has not established a complete session. |
| `ready`       | The current session is live and new events may arrive.                 |
| `stale`       | The retained current-session rows precede an observation gap.          |

The Controller source owns `/logs` in a collector that is independent from the
Status and Traffic observation session. It opens the pinned core's structured
log stream before publishing a ready Events session. An initial handshake or
schema failure marks Events unavailable and records one bounded local
application boundary event. A failure after a ready Events session marks that
session stale immediately. Neither failure changes Controller Status, Traffic,
activation readiness, or command availability.

Reconnect revalidates the pinned Controller, creates a new globally distinct
source/session ID, resets sequence and the source buffer, and adds one
application boundary event. Repeated failures in the same unavailable or stale
phase do not append duplicate boundary rows. A recovered session never appends
to retained rows from the unavailable or stale session.

`events.subscribe` returns `{ subscriptionId, snapshot }`. The bridge installs
the current runtime's event receiver before sampling and sends the response
before later notifications. The RPC adapter treats transport disconnect as
stale and resubscribes with an authoritative snapshot.

Desktop runtime replacement changes Status, Traffic, and Events as one profile
boundary. The socket installs the replacement runtime's receiver and publishes
its Events snapshot. The Web provider replaces its local buffer whenever
profile ID or session ID changes, so two runtimes cannot form a false continuous
log.

## Retention and local clear

The Controller adapter stores at most the newest 1,024 redacted events in
memory. The Web provider also stores at most 1,024 deduplicated rows from one
session. Neither buffer is persisted.

Clear Local empties only the Web provider buffer while retaining its seen-ID
watermark. A later snapshot cannot silently repopulate cleared rows, but newly
observed rows continue to appear. It does not delete Mihomo logs, configuration,
profiles, runtime state, or files.

Pausing freezes the rendered rows without pausing collection. Resume reconciles
to the current bounded local buffer and reports how many newer rows accumulated.
Follow Latest changes only scroll position. Text, severity, source, and order
filters never discard underlying buffered rows.

## Source redaction and copy policy

Controller messages are redacted before they enter `EventRecord`. The source
redactor removes complete URLs, URL user-info and query data, credential and
token key/value forms, subscription identifiers, absolute paths, IP addresses,
and long token-like values. Structured field values pass through the same
redactor before they are joined into bounded detail text.

The RPC contract therefore transports only redacted event strings. The UI copy
action formats exactly one selected DTO and never reads raw Controller data,
configuration, files, or another event. There is no multi-row copy or export in
this slice.

Repository fixtures use only reserved `.invalid` names, documentation address
ranges, synthetic labels, and `/synthetic/` paths. Fixture clients perform no
network, file, Controller, or system operation.
