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

Save accepts only the preview ID. The desktop Tauri host owns destination selection,
private atomic writing, cancellation, and stale-preview cleanup. No path,
contents, upload target, arbitrary file read, Core command, or capture command
crosses the Web boundary.

## Included evidence

The JSON contains application/Core version status, the last activation outcome,
platform version, capability status, non-sensitive active-profile identifiers,
capture desired/observed/drift state, direct service-probe aggregates, bounded
event counts by source and severity, a redaction report, and bounded termination
or recovery evidence.

It excludes raw profiles and YAML, subscription URLs, credentials, full paths,
node and policy labels, connection destinations, process paths, network
addresses and hostnames, private endpoints, Controller payloads, status-bar
labels, and event text. Event rows are represented only by aggregate counts and
time range. Repository tests use fictional fixtures and prove the source
snapshots are not mutated during export.
