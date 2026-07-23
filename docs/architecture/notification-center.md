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

The Rust/TypeScript **Seam** carries only a canonical type reference, severity,
bounded JSON parameters, a dedupe key, replacement keys, pinned/resolution
state, and Rust-owned lifecycle metadata. It never carries localized title,
message, or detail text, and never carries functions.

A notification type names a presentation definition, not a singleton record.
Each independent occurrence receives a distinct bounded dedupe key and therefore
a distinct Rust-owned ID. A producer reuses a dedupe key only while updating one
explicit lifecycle; after that lifecycle is resolved, publishing the key again
creates a new instance.

Rust rejects identifiers over 96 bytes, more than eight replacements, parameters
over 2,048 serialized bytes, nesting deeper than three levels, more than 32
aggregate entries, or strings over 160 bytes. Sensitive key names and values that
look like URLs, paths, credentials, bearer values, or long tokens are rejected.
Native producers map raw failures to closed semantic categories before the Seam.
After this generic validation, the Rust Module treats type-specific parameters as
opaque data: it has no central enum or concrete payload structure per notification
type. A future native consumer that needs one type can define a local
`TypedNotificationParameters` projection and decode it through
`NotificationRecord::parameters_as`; that opt-in projection does not change the
stored envelope or the notification-center Interface.

TypeScript owns a single presentation registry. Its Implementation maps type plus
parameters to localized title, message, detail, toast policy, and bounded action
descriptors. Unknown types use a fixed safe fallback and do not display their
parameters. Action descriptors contain data only; the UI Adapter dispatches them
to existing typed commands and keeps pending state client-local.

This split provides **Leverage**: Rust guarantees one synchronized lifecycle for
every surface while TypeScript can re-localize retained records without changing
or migrating stored copy.

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
