# Support Bundle Data Contracts

## Product boundary

Events exposes chronological, already-redacted evidence. Automatic preflight,
semantic notifications, notification actions, and Events history explain
launch and runtime failures. There is no user-started Guided Diagnostics
surface, run history, cancellation command, or diagnostics RPC.

The remaining Core-independent observations keep their owning surfaces:

- direct service probes are automatic Status evidence;
- scoped proxy delay tests remain explicit Routes commands;
- DNS and platform observations remain Settings and Status evidence;
- application lifecycle events remain bounded Events history; and
- semantic notifications remain the Rust-authoritative recovery surface.

This avoids a second interpretation path that could disagree with automatic
preflight or expose generic duplicate failure copy.

## Support bundle boundary

Support bundle preview and save use a private Tauri boundary, not loopback RPC.
Ordinary browsers and demo mode receive an explicit unavailable adapter.
Preview creates the exact bounded in-memory JSON and returns only:

- an opaque preview ID;
- format, exact size, and maximum size;
- the included event time range;
- closed category names with item counts; and
- closed redaction categories.

The closed preview categories include `updater`, so the confirmation surface
discloses the bounded updater diagnostic before the exact bytes can be saved.

Save accepts only the preview ID. The desktop Tauri host owns destination selection,
private atomic writing, cancellation, and stale-preview cleanup. No path,
contents, upload target, arbitrary file read, Core command, or capture command
crosses the Web boundary.

## Included evidence

The format-version 4 JSON contains application/Core version status, the last activation outcome,
platform version, capability status, non-sensitive active-profile identifiers,
capture desired/observed/drift state, direct service-probe aggregates, bounded
event counts by source and severity, a redaction report, and bounded termination
or recovery evidence. It also contains one candidate-free updater diagnostic:
configured flag, semantic phase, revision, operation-presence boolean, and the
bounded maintenance reconciliation/version/capture-intent projection. It never
contains the candidate identity, journal ownership digest, metadata, signature,
endpoint, credential, or path.

It also contains bounded Traffic source-session transition evidence.

Format version 3 and protocol version 10 add `trafficSourceTransitions`. Each
entry uses closed enums plus only the transition disposition, source authority,
source revision, effect sequence, close-operation kind, failure kind, and target
count. The evidence records correlation outcomes such as committed, duplicate,
cancelled, retired, or reconciliation-required without recording the correlated
Profile, runtime, capture, Controller session, connection, destination, or
process identities themselves. Preview reports only the closed category and its
count.

Format version 4 and protocol version 11 add the candidate-free `updater`
diagnostic and preview category on top of that version-3 Traffic contract.

It excludes raw profiles and YAML, subscription URLs, credentials, full paths,
node and policy labels, connection destinations, process paths, network
addresses and hostnames, private endpoints, Controller payloads, status-bar
labels, and event text. Event rows are represented only by aggregate counts and
time range. Repository tests use fictional fixtures and prove the source
snapshots are not mutated during export.
