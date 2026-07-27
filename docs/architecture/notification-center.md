# Notification Center Architecture

## Authority and Module boundary

The notification center is one deep Rust **Module** owned by `MishRuntime` and
preserved across desktop runtime replacement. Its **Interface** accepts semantic
publications and exposes snapshot, subscribe, mark-read, and producer lifecycle
operations. The **Implementation** owns stable IDs, newest-first order,
monotonic snapshot and record revisions, replacement and resolution, shared read
state, producer retirement, and a 128-record retention bound.

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

## Client synchronization

Each client subscribes with an atomic baseline snapshot. A reconnect installs a
new baseline. Baseline records populate the center but never create toasts. A
record ID first observed in a later monotonic update creates exactly one
bottom-right Sonner toast. A later revision of that ID updates the same toast;
resolution dismisses it while retaining history. Stale or duplicate revisions
are ignored.

Ordinary toasts use Sonner's bounded default duration. A Rust-pinned record
instead produces a persistent toast and cannot be removed from the center while
its work is active. Resolution keeps the same record, clears its pinned state,
dismisses the toast, and exposes per-instance removal. This gives the lifecycle
**Depth** without sending presentation policy across the Seam.

Opening the center marks retained IDs read through Rust. The explicit X appears
only on hover or its own keyboard focus and removes only an unpinned record ID
through the Rust **Interface**; every client observes the result. Rust lifecycle
replacement, resolution, producer retirement, and bounded retention remain
authoritative. Toast dismissal, animation, and action-pending state retain UI
**Locality** and do not delete the center record.

## Interfaces

The JSON-RPC Interface is:

- `notifications.getSnapshot`
- `notifications.publish`
- `notifications.markRead`
- `notifications.remove`
- `notifications.removeByDedupeKey`
- `notifications.subscribe`
- `notifications.unsubscribe`
- `notifications.snapshot` subscription notifications

The fixture notification center implements the same client Interface for tests
and demo surfaces. It is an Adapter for fixture behavior, not a production
authority or compatibility reader.
