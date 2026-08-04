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

Detailed active connections, recently Closed derivation, and effective rules
use the independent Traffic contract documented in
[`traffic-data-contracts.md`](traffic-data-contracts.md). They are deliberately
excluded from `StatusSnapshotDto` so high-volume investigation data does not
expand the compact Status subscription.

`adapterKind` distinguishes `fixture`, desktop/browser `rpc`, and mobile
`native` snapshots. It describes the Status adapter that confirmed the view,
not the language used to implement Mihomo. Stale-state UI applies to every
non-fixture adapter.

## DTO families

| DTO                       | Required meaning                                                                             | Authority                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `RuntimeStatusDto`        | Core lifecycle, capture selection, confirmed System Proxy and TUN state, error or transition | Local bridge plus platform adapter               |
| `TrafficSnapshotDto`      | Current up/down rates and cumulative up/down bytes                                           | Mihomo traffic stream                            |
| `RuntimeMetricsDto`       | Memory in use, proxy-session uptime, active connections, effective rules                     | Mihomo observations plus local-bridge derivation |
| `ProfileSummaryDto`       | Stable profile ID/fingerprint and user-facing label                                          | Local bridge persistence                         |
| `PolicyGroupDto`          | Opaque group label, type, children, selected child, latency data                             | Mihomo proxy tree plus delay observations        |
| `GroupDelayPolicyDto`     | Internal policy ID, visible fixed HTTPS probe URL, and bounded timeout                       | Local bridge application policy                  |
| `GroupDelayTestDto`       | Group/profile/test identity, phase, direct-child outcomes, timestamps, and typed failures    | Local bridge plus revalidated Mihomo results     |
| `GroupUsageDto`           | Profile-scoped cumulative deduplicated connection observations                               | Local-bridge derivation                          |
| `ServiceMonitorDto`       | ID, opaque title, probe URL, bundled root-relative or user HTTPS icon URL                    | Local bridge persistence                         |
| `ServiceProbeResultDto`   | Monitor ID, latency, timestamp, status, explicit route target                                | Local-bridge probe execution                     |
| `PlatformCapabilitiesDto` | Supported capture modes, tray, vibrancy, and other native capabilities                       | Platform adapter                                 |

User-authored Mihomo labels are opaque Unicode strings. Production code must
not split, normalize, reorder, or infer structured emoji and text fields. The
demo fixtures may keep separate properties only for convenient mock
construction; that shape is not a production contract.

Built-in service icons are exact Remix Icon `v4.8.0` SVGs bundled under
`/assets/remix-icon/` and referenced with root-relative URLs. They therefore
resolve against the current Tauri or Browser Client origin, including an
advanced loopback port. Cloudflare intentionally uses the generic Remix cloud
symbol because that release has no Cloudflare brand icon.

User-authored icon metadata may instead contain a credential-free HTTPS URL.
The browser renders it only through `<img>`, omits referrer information, and
falls back to the bundled generic cloud icon for malformed values or load
errors. Rust validates and persists the URL but never fetches, proxies, caches,
or inspects its content. Other schemes and unrecorded local paths are rejected.

`PolicyGroupDto` is a discriminated union for `selector`, `url-test`,
`fallback`, `load-balance`, `relay`, `direct`, `reject`, and `unsupported`.
The original strict selector payload remains unchanged: it requires
`childIds`, `id`, `label`, a non-null `selectedChildId`, and
`type: "selector"`. Automatic groups may report a nullable current child;
terminal Direct and Reject groups have no children. An unsupported group keeps
its opaque upstream kind in `unsupportedType` so the UI can describe the
limitation without treating the group as a selector.

Group `childIds` may reference either another group or a proxy node. The Routes
view validates the complete graph before rendering it. Duplicate entity IDs,
duplicate child relationships, missing children, selections outside a group,
children on terminal groups, and cycles produce a safe graph error instead of
a partial or flattened route list. A node may still be referenced by multiple
groups; each reference remains under its owning group because that is valid
policy-graph structure rather than duplicate global state.

The current command contracts cover snapshot reads, capture and routing-mode
changes, active-profile selection, group-scoped child selection and delay
testing, service-monitor mutations, and Status subscription lifecycle. Every command returns a newly
confirmed `StatusSnapshotDto`; a JSON-RPC success envelope with an invalid result
is a validation failure, not command success. RPC snapshots must identify their
adapter kind as `rpc`, while fixture snapshots remain explicitly `fixture`.

### Policy-group selection while Core is stopped

Mish uses the disabled-while-stopped contract. `StatusSnapshotDto` carries the
Rust-derived `groupSelectionAvailability` value `available`,
`core-not-running`, or `unavailable`. A Controller-capable runtime publishes
`available` only from a current Running Core status. Starting, stopping,
stopped, and failed Core states publish `core-not-running`; a runtime without a
group command surface publishes `unavailable`. Desktop WebView and Browser
Client consume the same field. While it is `core-not-running`, selectable rows
remain browseable but their selection controls use the same native disabled
button state without a tooltip or focusable wrapper. Mouse, keyboard, and touch
therefore cannot dispatch a stopped selection. Web command admission checks the
newest accepted snapshot before creating command feedback, and Rust checks the
current Core status again before calling the Controller source. A race rejected
by that Rust check returns `core-not-running` with the current reconciliation
snapshot and produces no selection-failure notification.

The absence of explanatory UI is an intentional product exception to the
general disabled-control guidance: stopped policy rows already communicate
unavailability through their native disabled presentation, and adding a second
focus target solely for a tooltip creates inconsistent behavior across the
Desktop WebView and Browser Client. This exception does not weaken either Web
or Rust command admission.

Offline selection is intentionally rejected. The stopped Profile route catalog
contains a Profile ID and effective fingerprint, but its group and child IDs
are hashes of entity kind, that fingerprint, and the exact opaque label. The
Controller mapper uses the same label-derived identity because Mihomo does not
guarantee stable unique entity IDs. Provider-expanded children exist only in
the live Controller catalog. The `catalogRevision` and `membershipRevision`
used by post-switch connection cleanup are hashes of one live Controller
observation; they are neither persisted Profile revisions nor revisions shared
with the parsed offline catalog. Mihomo's private `cache.db` selection
persistence is Core-owned and does not provide a Mish command intent that can
be independently scoped, applied, confirmed, and retired. An offline queue
would therefore require label-only matching or an unprovable cross-catalog
revision bridge, both of which can apply a renamed, removed, replaced, or
provider-expanded target ambiguously.

No offline selection intent exists to survive a Profile replacement, catalog
change, runtime replacement, or failed launch. Those transitions only replace
the authoritative snapshot and keep selection unavailable until a compatible
running Controller catalog is confirmed. Running-Core selection remains the
existing operation: fresh version/catalog/membership revalidation, Controller
write, exact read-back confirmation, and the independent post-switch connection
behavior. Protocol version 33 adds this availability and the typed
`core-not-running` admission result without changing running operation identity
or confirmation semantics.

The presence of a command schema does not claim that every Status backend
implements that mutation. `StatusClient.supportsCommand` reports the backend's
provided command surface. Group selection additionally requires the current
Rust `groupSelectionAvailability` to be `available`; a stopped Controller-backed
runtime can therefore retain stable capability discovery without admitting a
mutation. The browser fixture supports isolated demo mutations.
The native desktop RPC adapter supports System Proxy capture and recovery plus
the shared TUN enable/disable command when the exact packaged helper is
confirmed healthy. The Developer-ID-free `internal-tun-alpha` profile is
supported only after its package version, installation identity, protocol,
enrollment, ownership, health, and fresh disabled observation succeed. Browser
RPC connections receive a TUN-unavailable capability projection and cannot
invoke Helper lifecycle or TUN Capture mutations, while they may still observe
the published runtime state. Unsupported packages remain unavailable.
The adapter advertises routing and group commands only when a Controller source owns
their reconciliation; lifecycle-only or missing-core composition keeps those
Controller commands disabled. Persisted profile activation uses the separate
authenticated Profiles command seam from both Profiles and the Status profile
selector. Desktop service-monitor commands and direct probes remain available
independently of the Core lifecycle. Capture controls also respect
the snapshot's `supported`, `unavailable`, `permission-required`, and
`repair-required` platform capabilities.

Routing and group commands return only after a post-command Controller read
confirms the requested value and its mapped snapshot has been published.
Timeout, rejection, disconnect, cancellation, runtime replacement,
pinned-version drift, inconsistent observation, unsupported group type, and
stale membership are distinct typed failures. The last confirmed snapshot is
refreshed and retained on failure; a 2xx Controller response alone never
produces a success state.

Group delay state has explicit `idle`, `pending`, `progress`, `cancelled`,
`completed`, `partial`, and `failed` phases. Each direct child is independently
`pending`, `success`, `failed`, or `cancelled`, with a positive latency or typed
failure and an observation timestamp for every terminal child. Timeout and
failure are never represented as zero latency. Routes sorts current successful
measurements by latency and places failed or cancelled measurements after valid
or unknown values. The browser fixture advertises no delay capability and cannot
publish synthetic desktop success.

Start accepts only a stable group ID, and cancellation accepts only the
server-issued test ID. The bridge chooses the fixed visible policy and validates
group membership before scheduling and again before publishing each result. A
profile/runtime replacement closes the old source and cancels its active test;
the replacement begins with an idle test context, so results cannot cross
profile identity.

`status.subscribe` returns both the subscription ID and a current validated
snapshot. The server resets that socket's lifecycle-event cursor before reading
the snapshot, then sends the subscription response before it can send a
notification for the new subscription. This creates an ordering barrier: events
older than the snapshot are discarded, while an event racing after the snapshot
is delivered after the response. The Status adapter applies the response snapshot
on every initial subscription and resubscription, and clears stale state only
after contract validation succeeds. A reconnect therefore becomes authoritative
without depending on a later lifecycle change. Protocol version 3 adds the
typed System Proxy runtime state and recovery command while preserving this
ordering barrier. Protocol version 4 adds Traffic close-command capability
discovery and typed confirmed results without changing Status snapshot ordering.
Protocol version 5 adds the group-delay policy, state, capability, and commands
while preserving the Status and Traffic ordering barriers. Protocol version 7
adds the independent Guided Diagnostics command and history contract without
changing Status subscriptions. Protocol version 9 adds the independent Profile
refresh-policy and runtime-provider contracts without changing Status
subscriptions. Protocol version 10 adds revision-bound structured Profile patch
commands and the User patches provenance layer without changing Status
subscriptions. Protocol version 14 adds the independent fixed-endpoint local
proxy readiness test without changing Status subscriptions or capture selection.
It accepts no caller-supplied target and does not observe or mutate System Proxy.
Protocol version 15 adds persisted service-monitor mutations, a fixed global
probe interval policy, and direct service-probe results without changing Status
subscription ordering.
Protocol version 18 adds the versioned privileged TUN network observation and
requires complete observed Core, interface, route, and DNS state before TUN can
be published as applied.
Protocol version 20 adds the Rust-authoritative filtered-visible Traffic close
command and capability without changing Status or Traffic subscription ordering.

Profile activation has one internal data-bearing Rust state and an exhaustive
Adapter into the existing idle, pending, success, and failure DTO phases.
Pending and terminal commands carry a target Profile and an internal authority
scope/revision; shared refinements reject contradictory public field
combinations. The profile subscription uses the same parent snapshot ordering
barrier and authoritative resubscription rule as Status. A committed activation
replaces the runtime host and completes the runtime handoff before the profile
success snapshot is published, so subsequent Status and Traffic reads use the
same active profile.

Capture selection is device-level intent and is distinct from confirmed runtime
state. The capture command carries the complete selection plus an aggregate
active flag. Stopping may therefore disable both runtime paths without erasing
the selection, while starting can restore the complete remembered combination.
The default selection is off, and profile activation does not mutate it.

`RuntimeMetricsDto.uptimeSeconds` measures the current aggregate proxy session,
not the managed Mihomo Core process lifetime. The shared runtime starts the
timer when an authoritative snapshot first confirms either System Proxy or TUN
as applied, continues it while either remains confirmed, and clears it as soon
as neither is confirmed. Remembered capture selection, optimistic commands, and
unconfirmed pending, failed, or drift states cannot extend a session. A Core
restart does not reset an otherwise continuously confirmed capture session; an
ordinary proxy stop does, even when the managed Core remains running.

Status protocol version 24 publishes `recentTraffic`, the Rust-authoritative
process-memory capture-session snapshot. It contains process `authorityId`,
monotonic `revision`, capture `sessionId`, bound Profile identity,
idle/active/suspended phase, monotonic session totals, current paired rates,
the fixed one-second cadence and 60-second window, and at most 60 aligned paired
samples. Remounts, reconnects, and simultaneous clients consume the same
snapshot; stale or duplicate same-authority revisions cannot regress the Web
projection. React derives only sparkline arrays and local animation.

Protocol version 25 adds `applicationOrder` to complete Status, Profile,
Events, and detailed Traffic snapshots. Its process `authorityId`, runtime
`epoch`, and per-stream monotonic `order` are allocated by one Rust application
snapshot authority. Reads reserve their order before crossing an asynchronous
seam, runtime replacement advances the epoch, and identical content reuses its
canonical order for simultaneous clients. Request results, command results,
subscription updates, and reconnect baselines pass the same Web acceptance
module. Reauthentication arms a one-shot reconnect barrier, so the first valid
baseline, read, or complete command result can establish the current process
authority even when no snapshot listener exists. Once established, a delayed
retired authority cannot reopen the cache. A duplicate closes the barrier only
when the receiving layer knows it was the actual incoming result; a normalized
cached result cannot prematurely make an outer Provider current. Lower
epochs/orders are stale, exact duplicates are idempotent, and equal order with
different content is a contract conflict. The parent envelope composes with,
and never redefines,
`recentTraffic.authorityId/sessionId/revision`.

Status protocol version 26 adds `RuntimeStatusDto.captureOperation` as the
aggregate capture transition envelope. Rust allocates a non-zero, bounded
decimal `operationId` when an aggregate command is admitted and binds it to one
opaque `scopeEpoch` owned by the capture reconciler. The envelope publishes
`idle`, `pending`, `applied`, `failed`, or `recovery-required`; the same
operation ID remains attached from pending through its terminal projection and
is retained for reconnect baselines. A terminal ID is retired only when the
same scope admits its next operation; replacing the capture scope starts a new
epoch in idle state. Native and RPC adapters project this envelope unchanged,
and Web readers compare IDs only within one epoch, reject a delayed pending or
older terminal projection, and reject projections from a retired epoch.
Read-only periodic audits preserve the retained terminal envelope and publish
nothing when authoritative capture semantics are unchanged; only an actual
platform mutation or a detected authoritative transition admits a new operation.
`captureOperation` is transition identity only and does not alter the nested
`recentTraffic` authority, session, totals, cadence, retention, or revision.

Status protocol version 34 adds a typed `failure` and the `finalizing` phase to
that same envelope. `pending` covers admitted validation and mutation work;
`finalizing` begins once a failure or cancellation is known and remains busy
until the owning coordinator finishes compensation and cleanup. Both phases
retain the same `scopeEpoch` and `operationId`, and both reject duplicate
commands. Web action feedback and typed notifications present this projection
but never complete, replace, or authorize the Rust operation.

The canonical ownership, lifecycle, privacy, and retention contract is defined in
[`runtime-state-ownership.md`](runtime-state-ownership.md). The detailed Traffic
workspace deliberately retains its independent Controller source session and
history semantics. The low-level `StatusSnapshot.traffic` field remains
unchanged for the protocol version 24 compatibility window. Status preserves
the chart layout but does not instantiate a curve until the authoritative
session contains at least three samples.

The toolbar profile value is configuration selection, not a Core-health claim.
It remains visible while the runtime is safely stopped and identifies the
profile used by the next start. Changing it is a preference mutation only and
does not activate Core. A frontend start from that state first completes
the selected profile's activation transaction, then sends the capture command;
it never asks the capture reconciler to apply System Proxy against an unhealthy
Core. A capture-mode click has the same immediate-start semantics as the
aggregate control.

`SystemProxyRuntimeStatusDto` reports `desired`, the observed classification,
the reconciliation phase, an optional typed failure, and bounded recovery
actions. `pending` means a transaction has not yet been confirmed; `applied`
means a fresh operating-system observation exactly matched Mish's managed
loopback endpoint; `failed` means no success was published; and `drift` means
the observed or safely knowable state differs from Mish ownership. The legacy
`systemProxyEnabled` convenience flag is true only for confirmed `applied`
state. Neither DTO exposes service names, prior proxy hosts, credentials, or the
private journal.

The transport-neutral Rust capture reconciler serializes mutations and records
the exact prior enabled, host, port, and authentication fields for HTTP, HTTPS,
and SOCKS, plus the PAC enabled state and URL, automatic-discovery state, and
network-service identity required to decide whether a write is safe and
reversible. Disabled manual proxies retain blank or populated fields instead of
being normalized to one equivalent value. It will not overwrite enabled PAC,
automatic discovery, or authenticated proxy configuration. Applying, restoring,
and moving between active network services are transactions: persist the complete
prior state, write manual values before their final enabled states, observe every
recorded field, and only then publish success. Ordinary release, safe stop,
shutdown, Core or activation failure, rollback, and restart recovery share this
exact restoration contract. A restart may restore an interrupted apply or
restoration only when every observed field is exactly either its persisted prior
value or the field's Mish transaction target. This admits only crash-created
partial matrices; any third value remains typed external drift and is not
written. Mish never rewrites the PAC URL: manual capture preserves that observed
content byte-for-byte. The default takeover policy also requires PAC and
automatic discovery to remain disabled. The explicit reversible-replacement
policy may disable and later restore their enabled states, but confirmation
still requires the PAC URL and every other field to match exactly. An
unconfirmed outcome remains explicit drift with
`repair` and `leave-as-is`; repair adopts the currently observed safe state as
the new prior, while leave-as-is clears Mish ownership without changing the OS.

macOS treats a successful `networksetup` mutation as command acknowledgement,
not confirmation. Its capture adapter makes an immediate full-state observation
and, only while the active service remains the transaction target, retries that
same observation through an explicit two-second propagation budget. The budget
bounds the observation futures as well as retry intervals, and exact rollback
confirmation uses the same window against the journaled service. A matching
full matrix is the sole path to `applied`; a stable mismatch rolls back exactly
to the journaled baseline, while a service change is typed external drift and
leaves the newly active service untouched. The window carries no proxy values,
service identifiers, or profile data into diagnostics or notifications.

The desktop bridge audits capture ownership at restart, on core health changes,
and periodically as a bounded fallback. The macOS shell also publishes typed,
monotonically sequenced sleep, wake, and primary-network-service events through
a narrow platform source. The application coordinator serializes these events
and rejects stale sequence numbers. Native callbacks contain no capture,
Controller, or UI policy.

Sleep pauses the active Controller collectors and marks their Status, Traffic,
and Events observations non-authoritative. Wake invalidates the old mapper,
connection, event-session, group-delay, and guided-diagnostic authority before
starting a fresh pinned-version and complete-initial-batch confirmation. A core
exit performs the same hard invalidation and conservatively restores only an
exact Mish-owned or transaction-owned partial System Proxy matrix. A later
confirmed core restart creates new Traffic and Events sessions and reapplies a
capture mode only when the stored user selection is still explicit and its
System Proxy listener or signed TUN helper is confirmed ready.
Network-service changes reuse the capture transaction: restore the prior service
first, then apply the new active service only under that same explicit intent.
Observation, listener, apply, rollback, and confirmation failures remain typed
failed or drift state. If an external actor changed the settings, Mish leaves
them untouched. TUN uses the same serialized transition authority and never
derives success from selection or generated configuration alone.
`TunRuntimeStatusDto` carries the privileged observation schema version and
timestamp plus closed Core, Mish-owned interface, managed-routes, and DNS
component states. `tunEnabled` is true only when the phase is `applied` and a
fresh observation confirms every component. Partial, stale, foreign, missing,
and residual-cleanup observations remain typed failed or drift state, and the
native status bar and Web UI project the same non-active runtime snapshot.
Unsupported, unsigned, unpackaged, permission-refused, version-drifted, or
unconfirmed helper states remain typed unavailable or failed as defined by
[`macos-tun-helper.md`](macos-tun-helper.md).

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

Rust Status state is now typed in `crates/runtime`. The generic
`StatusDataSource` boundary can be implemented by desktop or embedded hosts
without introducing Controller transport dependencies into runtime. The
Controller-specific mapper and observation source live in
`crates/desktop-bridge`. The source is the desktop owner for Controller fetching,
stream lifecycle, freshness, reconnects, and close. It attaches to the runtime's
transport-neutral event sink so accepted observations and diagnostic changes
are visible through both Status snapshot RPC methods. `StatusDataSource` also
has an awaited shutdown hook; runtime shutdown closes the source before stopping
the core lifecycle.

Controller composition is opt-in. The desktop host must inject one explicit
loopback base URL, optional secret, profile identity/fingerprint/label,
Controller limits and timing policy, and the same lifecycle object used by
`MishRuntime`. Without that configuration, runtime construction remains
lifecycle-only and performs no Controller read or configuration discovery.

The Rust `PolicyGroupKind` and Controller mapper emit selector, URL test,
fallback, load-balance, relay, direct, reject, and unsupported variants using
the same discriminated contract as TypeScript. Only Selector is eligible for a
manual command. Unknown upstream kinds retain their opaque type and remain
read-only.

## Mihomo core source mapping

| Product value                       | Mihomo source                                                                        | Notes                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current rates and totals            | `/traffic` stream (`up`, `down`, `upTotal`, `downTotal`)                             | The UI formats units; totals reset when their upstream source resets.                                                                                  |
| Memory in use                       | `/memory` stream (`inuse`)                                                           | Present as Mihomo memory, not total app memory.                                                                                                        |
| Active connections                  | `/connections` snapshot or stream                                                    | Count live connection records, not historical observations.                                                                                            |
| Policy groups and selected children | `/proxies`                                                                           | Preserve nested group structure and group-scoped selection.                                                                                            |
| Select a group child                | `PUT /proxies/{group}` with a child name                                             | Validate the child still belongs to the group.                                                                                                         |
| Direct-child delay                  | `GET /proxies/{name}/delay` with application-owned URL, timeout, and expected status | Mish schedules only children captured from one current group and revalidates membership before publishing.                                             |
| Rules                               | `/rules`                                                                             | Exclude entries explicitly marked disabled when presenting an effective count. Do not assume every implementation exposes identical disabled metadata. |
| Routing mode                        | `GET /configs` observation and `PATCH /configs` mutation                             | Represent Rule, Global, and Direct as a closed product enum and confirm the patched mode through a fresh observation.                                  |

`/proxies` is available only while Mihomo is running. When no live catalog is
available, Routes may read the selected Profile's bounded route catalog derived
from its patched effective YAML. That fallback has no current selection,
latency, health, or expanded proxy-provider membership and therefore remains
read-only. Once Controller observations are available, they replace the
configuration fallback.

The Controller response is a keyed map and does not carry authoritative
top-level policy-group order. Desktop activation therefore records the ordered
`proxy-groups` names from the generated effective configuration and applies
that order when mapping live groups. Direct child order continues to follow
each Controller group's `all` array.

For the implemented Controller mapper, profile IDs are caller-supplied. Group
and proxy IDs are deterministic SHA-256-derived identifiers scoped by a
caller-supplied stable profile fingerprint and prefixed with `group:` or
`proxy:`. The hash input uses the Controller entity ID when present and the
exact opaque label otherwise. Renaming an entity without a Controller ID
therefore changes its derived identifier; changing profiles always changes it.

The mapper consumes coalesced observation batches. Missing batch fields retain
the last valid value, while an explicitly empty connection snapshot sets the
active count to zero. It retains at most 512 traffic-rate observations and a
bounded recent set of connection IDs for group-usage de-duplication. Invalid
catalog relationships reject the batch transactionally instead of inventing a
selected child.

The desktop source stores only a mapper produced by a valid batch. An invalid
later observation therefore leaves all prior Controller-derived values intact,
while the Status runtime phase and message expose the source failure. Stream or
transport loss follows the same stale-data rule and starts a new session after
the configured reconnect delay. Session recovery revalidates the pinned version
and requires a complete initial batch before clearing the diagnostic state.

The Controller traffic DTO preserves Mihomo's signed 64-bit wire fields. At the
Controller-to-Status boundary, the mapper checked-converts each rate and total
to the non-negative Rust Status representation used by the product contract.
Negative values return a typed `StatusMappingError`; the entire observation
batch is rejected transactionally, including rate-series updates, so the last
valid Status state remains available. Every non-negative signed value, including
`i64::MAX`, is accepted without clamping, wrapping, or changing its magnitude.

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
6. Consumers sort descending, apply a stable tie-breaker, and show the first
   five groups.

Counts are heuristic ranking input. They are not exact request totals, billing
data, or a user-facing metric. The mapper uses saturating per-profile counts and
retains the latest 65,536 connection IDs by default, evicting oldest IDs first.
Profile deletion and durable count persistence remain composition concerns.

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

When periodic testing is enabled, new and restored state uses a five-second
cadence; the user may select 5, 10, 30, or 60 seconds, or disable periodic
cycles. Initialization and each service-configuration revision generate a
random service order. Each non-overlapping cycle retains that order and evenly
spaces probe starts across the selected interval instead of issuing a burst.
At most 12 service monitors are retained. A stored list longer than 12 is
directly truncated to its first 12 definitions; old default identities, URLs,
icons, and intervals are not otherwise migrated. In disabled mode, the bridge
runs one evenly spaced cycle
whenever Core starts and otherwise retains the latest results. The scheduler
remains bridge-owned, so replacing Core does not discard those results. Monitor
definitions and the selected interval are stored in the application-data
directory and overlaid onto every Status snapshot, including lifecycle-only
snapshots. Probe updates publish through the existing Status subscription.

Automatic and immediate probes are independent requests, including when their
URLs normalize to the same host. This preserves scheduled start offsets instead
of queuing or coalescing work behind a slow request. Valid `Retry-After` values
from HTTP 429 or 503 responses take precedence for requests that have not yet
started; otherwise host failures back off through 5, 15, 30, and 60 minutes,
then 2, 4, and at most 6 hours. A successful response resets that host state.
Configuration revision changes and bridge shutdown cancel obsolete transport
work, and stale revisions never publish.

The immediate test command accepts only an existing monitor identifier. The
bridge resolves the stored, previously validated URL, retains the last result
while the request is running, and publishes the new outcome after completion.
The RPC does not accept a caller-supplied URL or route target.

The reported value ends when response headers arrive. It is direct HTTP
first-response/service-connectivity latency, including DNS, TCP, TLS, and
response-header time; it is not bandwidth, pure RTT, complete body load, Git
operation performance, or complete application experience. One configured
`reqwest::Client` is reused. Redirects remain disabled and the request bound is
eight seconds. Responses with a known body no larger than 64 KiB may drain in
the background for connection reuse; oversized or unknown bodies are closed
without unbounded download and never delay the published header-time value.

Validate URLs as HTTP or HTTPS and protect the local machine from unintended
access to loopback, link-local, metadata, or private-network targets unless the
user has explicitly enabled a trusted local-monitor use case. Store errors as
typed outcomes such as timeout, DNS failure, TLS failure, rejected status, or
policy rejection rather than converting all failures to a synthetic latency.

## Mock boundary

The `pnpm demo` values, profile names, labels, connection counts, traffic,
memory, rules, latencies, and service results are fixtures. Demo interactions may
change local React state, but they do not call Mihomo. Production work must keep
fixtures behind a DTO boundary rather than importing core response objects
directly into components.

`packages/mock-bridge` is a separate contract-test implementation. Unlike the
in-process production fixture, it exercises real JSON-RPC serialization,
authentication, Host/Origin admission, WebSocket delivery, subscription and
cancellation framing, schema rejection, and remote failures. Its snapshot is
static input, every lifecycle command fails explicitly, and it does not decide
Core or Capture transitions. Its `fixture-only` capability values and
deterministic measurements must not be presented as Mihomo or operating-system
observations.

## References

- [Mihomo controller API](https://wiki.metacubex.one/en/api/)
- [Mihomo proxy groups](https://wiki.metacubex.one/en/config/proxy-groups/)
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
