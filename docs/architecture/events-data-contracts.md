# Events Data Contracts

## Scope

Events uses an independent snapshot and subscription contract. Event rows do
not belong in the compact Status snapshot and do not share Traffic retention.
The same transport-neutral contract is consumed by the browser fixture, desktop
RPC adapter, and future native adapters.

The Events surface remains read-only. It exposes a bounded local event view and
one safe-copy action for a single already-redacted event. The desktop-only
support bundle action exports aggregate event counts through a separate private
Tauri boundary; the Events snapshot and RPC contracts define no export, upload,
arbitrary file read, telemetry, core stop, or core mutation command. See
[`support-bundle-data-contracts.md`](support-bundle-data-contracts.md).

## Snapshot shape

`EventsSnapshotDto` contains:

- adapter kind and active profile ID;
- observation phase, monotonic sequence, session ID, and reconnect count;
- at most 1,024 current-session event records; and
- explicit availability for application, core, RPC, and platform sources.

Each event has a stable session-scoped ID, sequence, local receipt timestamp,
severity, and source. It contains exactly one of:

- a generated `ApplicationEvent` with a semantic kind, kind-specific typed
  data, and stable action IDs; or
- bounded, already-redacted `EventEvidence` message/detail text from Core, RPC,
  or platform observations.

An Application source must use semantic content, while non-Application sources
must use evidence content. Severity is the closed set Debug, Info, Warning, and
Error. Source is the closed set Application, Core, RPC, and Platform.

Events are diagnostic history only. They do not carry notification kinds and are
not an input, compatibility reader, or backing store for the notification center.
The independent Rust-authoritative lifecycle is specified in
[`notification-center.md`](notification-center.md).

The desktop Controller adapter currently supplies redacted Mihomo Core evidence,
generated application-owned session-boundary observations, and semantic
lifecycle diagnostics for activation and capture failures. A safe-stopped runtime may
therefore expose a ready application-only event session while core, RPC, and
platform sources remain explicitly unavailable. Browser values are marked
`fixture` and every source is marked `fixture-only`; they are never presented as
desktop observations.

The Android native adapter projects complete VPN service and Mobile Core
lifecycle facts through the same closed source/severity/evidence taxonomy.
Kotlin supplies only closed native observations. Shared Rust owns the Events
authority, session ID, monotonic sequence, 1,024-row history, redacted message
mapping, gap recovery, and runtime replacement. Initial bind, rebind, and a new
Activity/WebView client all subscribe before fetching a complete baseline. A
native fact-sequence gap rotates the Events session, clears incomplete retained
rows, increments reconnect count, and records one closed reconciliation row.
Raw exception, JNI, URL, path, token, configuration, or native response text
has no field in the Android projection.

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

Android replacement is also baseline-only. A Web notification from a different
authority can trigger a fresh full baseline but cannot itself establish the
successor. Once that baseline is accepted, the previous authority is retired;
its delayed notifications have zero mutation even when epochs or sequences
overlap. Search, level/source filters, pause, ordering, Follow Latest, and Clear
Local remain view-local and reset when the Events session is replaced.

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

Controller evidence is redacted before it enters `EventRecord`. The source
redactor removes complete URLs, URL user-info and query data, credential and
token key/value forms, subscription identifiers, absolute paths, IP addresses,
and long token-like values. Structured field values pass through the same
redactor before they are joined into bounded detail text.

Application lifecycle producers construct generated semantic payloads from
closed failure categories. Their constructors accept no localized copy, profile
labels, source URLs, configuration text, Controller credentials, or arbitrary
error strings. React localizes these payloads only when rendering. A retained
history therefore changes language without changing identity, sequence, order,
or replaying any notification toast. Events contain no recovery deep link:
typed notification actions own recovery, while event rows remain selectable
evidence.

The RPC contract therefore transports semantic Application events and
non-localized redacted evidence as distinct fields. It has no compatibility
reader for the former Application `message`/`detail` shape. The UI copy action
formats exactly one selected render-time projection and never reads raw
Controller data, configuration, files, or another event. Support bundles do not
copy rows: they derive only bounded counts by closed source/severity enums and a
time range from the runtime snapshot, so event IDs, semantic data, messages, and
details never enter the file.

Repository fixtures use only reserved `.invalid` names, documentation address
ranges, synthetic labels, and `/synthetic/` paths. Fixture clients perform no
network, file, Controller, or system operation.

## Android fixed diagnostic

Android adds exactly one diagnostic operation beside Events. Its policy is
compiled into Shared Rust and Kotlin: `android-connectivity-v1`, target
`https://www.gstatic.com/generate_204`, timeout 5,000 ms, at most four typed
checks, and at most eight terminal runs in volatile memory. The command accepts
only a bounded operation ID; Shared Rust mints the run ID. There is no caller
endpoint, timeout, suite selection, export, upload, persistence, notification,
or desktop loopback command.

Shared Rust owns run admission, ordering, terminal classification,
cancellation, timeout, history bounds, replacement, and task join. Kotlin owns
only the fixed Android HTTP effect and returns closed check/outcome/failure
enums; it retains no product history or notification policy and discards raw
throwable text. Cancellation terminates the matching Rust run exactly once.
Replacement records `replaced/runtime-replaced`, cancels and joins the retired
task before installing a successor authority. Delayed old-runtime effects and
completions cannot mutate the new authority.
