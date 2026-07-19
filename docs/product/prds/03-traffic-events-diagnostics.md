# PRD 03: Traffic, Events, and Diagnostics

## Metadata

- Status: Draft for product review
- Version: 0.1
- Date: 2026-07-18
- Destinations: Traffic and Events

## Product bet

For a user asking “what is happening?” or “why did this request fail?”, connect
live connections, matched rules, route chains, application/core/platform events,
and guided tests into one investigation path. Success means common failures can
be explained and exported without reading raw logs first or leaking secrets.

## Product organization

Clash Verge Rev exposes Connections, Rules, Logs, and Unlock Tests as four
separate primary destinations. The product will instead use two destinations:

- **Traffic** owns current and recently closed connection facts, including the
  matched rule and route chain.
- **Events** owns chronological app/core/platform events, guided diagnostics,
  and redacted export.

Rules remain searchable reference data inside Traffic. Service reachability and
route tests are diagnostic tools, not a top-level entertainment-unlock promise.

## Requirements: Traffic

| ID             | Priority | Requirement                                                                                                                                            | Acceptance criteria                                                                                                                                                                             |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TRAFFIC-F-001  | P0       | Traffic shall separate active and recently closed connections.                                                                                         | Given a connection closes, when the next snapshot arrives, then it leaves Active and may appear in the bounded Closed view without being counted as active.                                     |
| TRAFFIC-F-002  | P0       | The list shall show destination, process when available, network/protocol, start time or duration, current/total bytes, matched rule, and route chain. | Missing platform data is labeled unavailable; the UI does not fabricate process identity or geography.                                                                                          |
| TRAFFIC-F-003  | P0       | Filtering shall support plain text plus structured dimensions.                                                                                         | Users can filter by destination, process, rule, group/child in chain, network type, and state; clearing filters restores the current dataset.                                                   |
| TRAFFIC-F-004  | P0       | Connection detail shall preserve the complete rule and chain.                                                                                          | Given a chain traverses multiple groups, then detail shows the ordered chain and does not collapse it to one active node.                                                                       |
| TRAFFIC-F-005  | P0       | Users shall be able to close one active connection.                                                                                                    | Given an active connection, when Close is confirmed by the core, then the row transitions to closed; failure leaves it active with an explanation.                                              |
| TRAFFIC-F-006  | P0       | Users shall be able to close all currently active connections with clear scope.                                                                        | Given filters are active, the action explicitly states whether it affects all or only visible connections and prevents accidental ambiguity.                                                    |
| TRAFFIC-F-007  | P0       | Traffic shall expose a searchable, read-only effective rule list.                                                                                      | Given rules are loaded, when a query matches type, payload, or target, then ordered results show their effective priority and disabled rules are distinguished or excluded per core capability. |
| TRAFFIC-F-008  | P1       | Traffic shall support bounded pause/freeze for inspection.                                                                                             | Pausing freezes row updates without stopping collection; resuming reconciles to the latest bounded dataset and states what was skipped.                                                         |
| TRAFFIC-F-009  | P0       | Closed history shall have explicit local retention and clear semantics.                                                                                | Given recently closed rows exist, when Clear is invoked, then only the local bounded history is removed and no core configuration, persistent log, or active connection is affected.            |
| TRAFFIC-NF-001 | P0       | High-volume streams shall remain responsive.                                                                                                           | Under the agreed connection-rate fixture, input, scrolling, and command controls remain responsive and memory stays within budget.                                                              |

### Current confirmed-command vertical slice

Traffic uses an independent snapshot/subscription contract for Active
connections and effective Rules. Recently Closed remains a bounded, in-memory
client derivation. The desktop runtime now supports confirmed close-one and
“Close all active connections” commands. The latter always targets the complete
current active snapshot and explicitly ignores UI filters. Both commands use
snapshot/session/profile authority, refresh on typed failure, and require a
post-command Controller snapshot before success. Browser fixtures advertise the
commands as unsupported and never simulate desktop mutation success. See
[`../../architecture/traffic-data-contracts.md`](../../architecture/traffic-data-contracts.md)
for sequence, reconnect, stale, retention, precision, and privacy semantics.

## Requirements: Events and diagnostics

| ID           | Priority | Requirement                                                                                                                 | Acceptance criteria                                                                                                                                                                                                                            |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EVENT-F-001  | P0       | Events shall combine Mish application, Mihomo core, RPC, and platform-adapter events with source and severity.              | Given concurrent events, then each row has timestamp, severity, source, concise message, and optional structured detail.                                                                                                                       |
| EVENT-F-002  | P0       | Users shall filter by severity, source, time, and text.                                                                     | Filters are composable, keyboard accessible, and do not discard the underlying bounded event buffer.                                                                                                                                           |
| EVENT-F-003  | P0       | Users shall pause visual follow, change chronological order, and clear the local view.                                      | Clear affects the displayed local buffer only unless a separate persistent-log deletion action explicitly says otherwise.                                                                                                                      |
| EVENT-F-004  | P0       | Common failures shall link to contextual recovery or a guided diagnostic.                                                   | A core start failure, permission denial, profile validation failure, DNS failure, and System Proxy drift each expose a relevant next action.                                                                                                   |
| DIAG-F-001   | P0       | Guided diagnostics shall test the layers needed to localize a failure.                                                      | A run reports desktop-bridge reachability, core health, active profile validity, capture state, DNS resolution, direct reachability, and explicitly scoped proxy/group reachability.                                                           |
| DIAG-F-002   | P0       | Diagnostic results shall distinguish observation from inference.                                                            | Each check includes scope, time, route target, observed result, and a plain-language interpretation that does not overclaim global connectivity.                                                                                               |
| DIAG-F-003   | P1       | Users shall be able to export a redacted diagnostic bundle.                                                                 | Before export, the UI previews included categories and redactions; default output excludes credentials, subscription URLs/tokens, full user paths, IPs when not required, and raw configuration secrets.                                       |
| DIAG-F-004   | P1       | Diagnostic bundles shall include enough version context for support.                                                        | With consent, the bundle includes app/core/OS versions, capability state, recent bounded events, profile summary/fingerprint, capture observations, and check results.                                                                         |
| DIAG-F-005   | P1       | Service-specific tests shall be user-managed and neutrally named.                                                           | A test reports whether a configured endpoint responded through a named route; it does not promise content availability or a globally active node.                                                                                              |
| DIAG-F-006   | P1       | Users shall be able to inspect the effective runtime configuration and its layers.                                          | Given a profile is active, when the inspector opens, then it distinguishes source profile, local overrides, platform-derived values, and final runtime output; secrets are redacted and the final view is read-only.                           |
| DIAG-F-007   | P1       | Diagnostics and recovery actions shall be grouped by failure layer rather than placed in an unrelated advanced-action list. | Given a profile, DNS, core, capture, or update failure, then the corresponding check, evidence, and recovery action are reachable from one Diagnostics and Recovery entry point.                                                               |
| DIAG-F-008   | P1       | Endpoint and service probes shall retain scoped result metadata.                                                            | Given a probe completes, then its result includes endpoint or service identity, route scope, observed status, relevant region only when the check supplies it, completion time, and typed failure without changing the user's route selection. |
| EVENT-NF-001 | P0       | Default event retention shall be bounded and local.                                                                         | Restart, size, and time retention follow a documented policy; telemetry transmission does not occur without explicit opt-in.                                                                                                                   |

### Current read-only Events vertical slice

The first Events delivery uses an independent snapshot/subscription contract
for redacted Mihomo core logs plus local session-boundary observations. It keeps
at most 1,024 events in each desktop and Web memory buffer, replaces rather than
joins buffers across reconnect and runtime/profile boundaries, and exposes
explicit unavailable states for RPC tracing and platform events. Pause, follow,
filter, order, single-event safe copy, and Clear Local are view operations only.

Guided diagnostics and diagnostic export remain outside this slice. No export,
upload, arbitrary file read, telemetry, or runtime mutation RPC is defined. See
[`../../architecture/events-data-contracts.md`](../../architecture/events-data-contracts.md)
for sequence, session, retention, redaction, fixture, and copy semantics.

## Empty, reconnect, and failure behavior

- A genuine empty connection or rule dataset uses a specific explanation, not
  the same generic empty state for “core unavailable,” “no profile,” and “zero
  matches.”
- When a stream reconnects, the UI indicates the observation gap and replaces
  stale active state with a fresh snapshot.
- Closed-connection history is best-effort diagnostic context, not a durable or
  billing-grade ledger.
- If process attribution requires privilege or is unsupported, the UI states
  that boundary and does not prompt for broad privilege merely to fill a column.
- Diagnostic tests never change routing mode or group selection unless a test
  explicitly requests and previews a temporary scoped change with rollback.
- Public-IP and network-identity details are masked by default and collected
  only when a diagnostic or user-managed monitor requires them.

## Privacy and security

- Destination hostnames, processes, local paths, and IP addresses may be
  sensitive. They stay local by default.
- Copy and export actions disclose their scope before data leaves the app.
- Redaction uses structured fields where possible; it must not rely only on
  regular expressions over rendered text.
- The client never uploads a diagnostic bundle automatically.
- Events from remote profile content are data, not instructions to the client.

## Metrics and validation

- A representative user can answer which rule and chain handled a selected
  connection in under 30 seconds.
- At least 80% of seeded DNS, profile, core, capture, and endpoint failures are
  localized to the correct layer without terminal use.
- Redaction fixtures demonstrate zero known credential leakage in default
  exports.
- Load fixtures verify bounded memory for connections and events over an
  eight-hour simulated session.

## Dependencies

- Mihomo core connections, rules, traffic, logs/events, and health data.
- Desktop-bridge event schema, bounded storage, stream sequence/reconnect metadata,
  and diagnostic runner.
- Platform observations for System Proxy, TUN, permissions, and process details.
- Profile summary and redaction schema.

## Open questions

1. What closed-connection and event retention is useful without turning the
   client into a long-term activity database?
2. Which process-attribution capabilities are supportable per OS without broad
   privilege?
3. Should effective Rules be a Traffic subview or a secondary inspector panel?
4. Which fields must be opt-in even inside a local diagnostic export?
