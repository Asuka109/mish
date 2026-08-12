# Notification Center Architecture

## Authority and Module boundary

The notification center is one deep Rust **Module** owned by `MishRuntime` and
preserved across desktop runtime replacement. Its **Interface** accepts semantic
publications and exposes snapshot, presentation claim/acknowledgement,
mark-read, and producer lifecycle operations. The **Implementation** owns stable
IDs, newest-first order, monotonic snapshot and record revisions, replacement
and resolution, shared read state, producer retirement, a bounded presentation
lease queue, and a 128-record retention bound.

This **Depth** keeps lifecycle policy behind one small Interface. Rust-native
producers call the Module directly. TypeScript-only producers cross the same
Interface through `notifications.publish`; no producer writes a React list or
calls Sonner. Events remain independent diagnostic history and are never an
Adapter for notification retention.

## Semantic transport and presentation

The Rust/TypeScript **Seam** carries a generated `ApplicationNotification`
presentation (`kind`, kind-specific typed `data`, and stable `actionIds`),
severity, a dedupe key, replacement keys, pinned/resolution state, and
Rust-owned lifecycle metadata. It never carries localized title, message, or
detail text, and never carries functions.

A notification kind names a presentation definition, not a singleton record.
Each independent occurrence receives a distinct bounded dedupe key and therefore
a distinct Rust-owned ID. A producer reuses a dedupe key only while updating one
explicit lifecycle; after that lifecycle is resolved, publishing the key again
creates a new instance.

Profile activation gives each allowlisted GeoData asset its own notification
kind and `command + asset` dedupe key. GeoSite, GeoIP, MMDB, and ASN preparation
can therefore remain visible at the same time, and each progress record keeps
its Rust-owned ID when it is resolved or upgraded to that asset's failure type.
Managed listener collisions use the separate
`profile.activation-listener-conflict` type and an activation-failure key; they
never replace or reuse a GeoData notification.

Internal TUN lifecycle operations publish `tun-helper.lifecycle` with the
bounded operation ID admitted by Settings and reuse that dedupe key from pinned
`pending`/`finalizing` to one terminal outcome. The record carries only the
closed operation, outcome, and typed failure category. Terminal failures expose
only `open-settings`; successful and pending records expose no inert action.
It replaces the generic Settings failure publication,
so install, repair, and remove cannot create duplicate frontend-only errors.
Removal uses the same operation ID in its private bounded occurrence record.
On process restart, retained failed or interrupted removal occurrences are
re-published as resolved history through this existing semantic kind and dedupe
key, not replayed as startup toasts; a later successful retry has its own
identity and cannot mutate the first failure. Successful historical removals
are not re-published.

Capture failures follow the same occurrence rule rather than treating
`capture.failure` as a singleton. An admitted Capture operation reuses its
scope-and-operation key only for updates to that operation; every pre-admission
rejection receives a fresh occurrence key. A later successful Capture lifecycle
resolves the outstanding Capture-failure namespace without collapsing its
retained occurrence history.

Every profile launch/preflight/runtime failure publishes one specific
`profile.activation-failed` semantic record. Retryable Rust failure categories
allowlist only `retry-profile-activation`; terminal categories expose no inert
action. Starting a new activation resolves the prior failed command's record,
while history remains retained. Events carry the same closed failure category
as evidence but no duplicate recovery link or generic banner.

Rust rejects identifiers over 96 bytes, more than eight replacements, semantic
presentations over 2,048 serialized bytes, nesting deeper than three levels,
more than 32 aggregate entries, or strings over 160 bytes. Sensitive key names
and values that look like URLs, paths, credentials, bearer values, or long
tokens are rejected. Generated exhaustive Rust enums require every native
producer to construct the exact data struct for its kind and reject action IDs
that are not allowlisted for that kind. Native producers map raw failures to
closed semantic categories before the Seam.

TypeScript validates the same generated discriminated union at the RPC boundary
and owns one exhaustive presentation registry. Its Implementation maps semantic
kind and typed data to localized title, message, detail, and toast policy. It
maps transported stable action IDs to localized labels and existing typed
commands while keeping pending state client-local. There is no unknown-kind
fallback, dual reader, or legacy localized-field adapter.

Occurrence severity is a historical fact owned by the Rust record. `resolved`,
shared `read`, and the presentation phase are independent transitions: resolving
an Error or Warning may clear stale recovery actions, release pinning, or
suppress a live toast, but it never changes that record into `Success`. A
genuine completion must arrive as an explicit semantic publication or typed
projection, with a different semantic payload when it updates one lifecycle;
the Web registry must never infer success from `resolved` alone. The optional
`outcome` on GeoData progress is the compatibility boundary for pre-existing
in-memory records: absence remains progress, while `prepared` is the explicit
success outcome. Notification retention is process memory rather than disk, so
a process restart begins empty; desktop runtime replacement transfers the same
Rust Module and therefore preserves each retained record unchanged.

System Proxy takeover refusals use a closed, redacted Rust reason only. The presentation maps a
recognized reason to a zero-argument native action; it never renders host names, PAC URLs,
credentials, service identities, or raw platform observations. The macOS Adapter owns one fixed
Network proxy destination and reports only confirmed dispatch, never a proxy-setting change.
Unsupported versions and failed dispatch keep the rejection record and open a localized manual
navigation dialog with explicit retry guidance. A secondary manual-steps action opens the same safe
dialog in a supported packaged application without simulating a native failure. The dialog closes
the notification popover, returns focus to its trigger, and never resolves the rejection record.

This split provides **Leverage**: Rust guarantees one synchronized lifecycle for
every surface while TypeScript can re-localize retained records without changing
their identity, order, read/removal state, or stored copy.

## Client synchronization and presentation leases

Creation and presentation are independent Rust-authoritative state machines. A
new record begins `unpresented`; it is not marked presented by publication,
snapshot retrieval, center reading, or React mounting. `resolved` remains a
separate producer lifecycle field and retained history fact. When a producer
resolves an occurrence while it is still `unpresented`, Rust atomically folds it
with `suppressed`: an obsolete recovery record cannot claim or block the global
queue. A record that already holds a live `presenting` lease retains that lease
and its normal acknowledgement, expiry, and reconnect semantics.

`notifications.subscribe` receives a validated `clientId` and short-lived
`sessionId`. While holding the notification lock it installs the live receiver,
claims the FIFO next eligible record, and returns `{ snapshot, claim,
subscriptionId }`. The sole returned claim moves that record to `presenting`
with a private owner identity, public lease generation, expiry, and current
record revision. A second WebView or Browser subscription sees the same
snapshot but no claim while that lease is current. The owner identity is never
projected in a notification record. The bridge binds each identity to one live
WebSocket; a concurrent socket reusing that pair is refused, so it cannot
acknowledge or release the owner's lease when it disconnects.

The client renders a Sonner toast only for its returned claim; it never infers
toast delivery from a baseline, a first-seen ID, or a revision difference. It
may call `notifications.claimPresentation` for the same subscribed identity to
obtain the current claim after a record revision changes. Completion uses
`notifications.completePresentation` and includes record ID, record revision,
lease generation, client ID, session ID, and an explicit folded outcome. Rust
accepts the acknowledgement only if every value still matches the current live
lease. Old, duplicate, equal-revision, disconnected, or replacement-session
messages therefore cannot fold a newer lease.

An explicit unsubscribe, WebSocket disappearance, client replacement, or lease
expiry requeues a live lease as `unpresented`; the next eligible client must
claim it atomically. A timeout, close button, or semantic suppression folds the
lease as `folded` while retaining the center record. This makes crash-before-
completion deterministic without treating a reconnect baseline as evidence of
delivery.

While a notification subscription is live, the bridge periodically asks the
Rust Module to expire the current lease. It emits no polling snapshots: Rust
broadcasts only when the expiry actually requeues a record, so a stalled but
still-open client cannot indefinitely block the global queue.

Ordinary toasts use the application's bounded eight-second default duration. A
Rust-pinned record makes the rendered toast persistent and prevents center
removal while its work is active, but pinning does not bypass the lease. Generic
resolution folds only an as-yet-unpresented record; it does not cancel or remove
a live lease. A semantic kind can additionally map a rendered update to
suppression (for example, resolved GeoData progress).

Opening the center marks retained IDs read through Rust without consuming an
unpresented or presenting lease. Toast timeout, explicit dismissal, action
execution, read state, producer resolution, and record removal stay separate
unless the semantic registry explicitly joins them. The explicit center X
appears only on hover or its own keyboard focus and removes only an unpinned
record ID through the Rust **Interface**; every client observes the result.
Toast geometry, animation, focus, and action-pending display retain UI
**Locality**, but they cannot decide the durable delivery lifecycle.

## Interfaces

The JSON-RPC Interface is:

- `notifications.getSnapshot`
- `notifications.publish`
- `notifications.markRead`
- `notifications.remove`
- `notifications.removeByDedupeKey`
- `notifications.subscribe`
- `notifications.claimPresentation`
- `notifications.completePresentation`
- `notifications.unsubscribe`
- `notifications.snapshot` subscription notifications

Desktop startup creates an eligible onboarding invitation through this Rust
Interface before any GUI surface starts. The first eligible client therefore
claims it exactly as it claims any other pre-GUI record; React never publishes
that production onboarding record.

The fixture notification center implements the same claim/lease/ack client
Interface for tests and demo surfaces. It is an Adapter for fixture behavior,
not a production authority or compatibility reader.
