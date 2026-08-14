# Bridge Protocol Contract

## Checked metadata source

`packages/bridge-protocol/bridge-protocol.json` is the repository-owned source
for the desktop bridge protocol version, supported compatibility bounds,
compatibility outcomes, capability-field names, public JSON-RPC methods, and
the transport-only mock's explicitly implemented method set. The source is
deliberately smaller than the DTO contract. Status, Traffic, Profiles,
Settings, Events, Notifications, and Updater DTOs remain owned by their domain
Modules.

`scripts/generate-bridge-protocol.ts` produces the TypeScript metadata binding
in `packages/contracts` and the Rust binding in `mish-bridge`.
`pnpm check:bridge-protocol` regenerates both files and fails when either is
stale. TypeScript tests compare the generated public method list with
`mishRpcMethods`; Rust integration tests send every generated public method to
the real server and reject any method-not-found result. The mock classifies
every generated method as either explicitly implemented or explicitly
capability-unavailable, so an unclassified default cannot silently expand its
contract.

## Compatibility negotiation

Protocol 36 adds a mandatory compatibility negotiation after authentication
and before any product method or subscription. The client calls
`bridge.getInfo` with its protocol version. The response contains the backend
protocol version, the minimum accepted client version, and exactly one outcome:

- `compatible` — product requests and subscriptions may proceed;
- `client-too-old` — the backend requires a newer client;
- `backend-too-old` — the client requires a newer backend.

The server records the outcome per authenticated WebSocket and rejects every
product method until that socket has negotiated `compatible`. Reauthentication
clears the prior outcome. The TypeScript RPC client repeats negotiation after
every reconnect and exposes `client-too-old` or `backend-too-old` as terminal,
stale connection phases. It does not retry with an older protocol, infer a
fallback capability set, or accept product snapshots before compatibility is
confirmed.

All production product clients share the same `RpcClient`, so Status, Traffic,
Profiles, Settings, Events, Notifications, and Updater cross one transport and
protocol gate. Their domain-specific command capabilities, errors,
subscription identity, snapshot acceptance, authority ordering, and reconnect
baselines remain separately owned. `bridge.getInfo.statusCommands` and
`trafficCommands` describe only those domain command capabilities; they do not
replace protocol compatibility.

Once a validated DTO leaves the wire client, ordered snapshot acceptance is
centralized by [`rpc-session-authority.md`](rpc-session-authority.md). The
protocol client does not own application-order policy, and a domain consumer
must not create a second generation, baseline, stale-response, or conflict
authority.

## Public method and mock boundary

Every method in the generated public list has a dedicated Rust dispatch arm.
`status.setActiveProfile` uses the Profile selection service and returns a
confirmed Status projection; it is no longer covered by a generic `status.*`
capability fallback. Capability-unavailable handlers use application error
codes rather than JSON-RPC's method-not-found code.

The TypeScript mock remains loopback-only, authenticated, and transport-only.
It performs the same compatibility negotiation and refuses product requests
after an incompatible result. Its fixture snapshots and explicit
capability-unavailable command results are contract evidence only; they do not
claim Core, Capture, native, or updater authority.

### Mock behavior inventory

Catalog parity is a method-presence check, not behavioral parity. The checked
`publicMethods` list ensures that the production server and the mock recognize
the same public names; it does not mean that the mock simulates every domain.
The mock validates declared parameter shapes for every catalog entry before it
selects one of the following bounded outcomes:

| Classification                              | Exact scope                                                                                                                                                                                                      | What the result proves                                                                                                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport implementation                    | `bridge.getInfo`, `core.getStatus`, `status.getSnapshot`, `status.subscribe`, `status.unsubscribe`, and `traffic.getProcessIcon`                                                                                 | JSON-RPC framing, authentication, protocol negotiation, schema validation, static snapshot/subscription framing, cancellation metadata, and the typed process-icon-null result.                                                                            |
| Fixture-only values                         | The stopped Core status, Status snapshot, service/traffic values, and the `status.subscribe` snapshot are cloned deterministic fixtures. `pnpm demo` uses separate in-process UI fixtures for demo interactions. | A consumer can be tested against the DTO and transport shape; no Core, Capture, operating-system, controller, probe, or updater observation or transition occurred.                                                                                        |
| Explicitly unsupported application behavior | Every other generated public method: all Events, Notifications, Profiles, Settings, and Updater methods; Status mutations/tests; and Traffic snapshot, subscription, and connection commands.                    | After normal parameter validation, the mock returns its typed capability-unavailable error (`-32020`), never JSON-RPC method-not-found and never invented success. Domain semantics belong in focused fixtures, native tests, or production-adapter tests. |

This is intentionally not a universal mock or a realistic domain simulation.
The catalog source is the authoritative complete method inventory; the
generated `BRIDGE_MOCK_IMPLEMENTED_RPC_METHODS` and
`BRIDGE_MOCK_UNAVAILABLE_RPC_METHODS` bindings classify it without a second
hand-maintained list. `scripts/check-mock-bridge-documentation.ts` checks that
this documented implemented set remains aligned with that catalog and that the
security claims below remain aligned with the desktop CSP and icon policy.

Protocol 37 adds the bounded updater maintenance and restart-reconciliation
projection. It carries only semantic phase, operation presence, revision,
capture intent, version classification, and the automatic-activation barrier.
It adds no public method: Browser Client and WebView callers retain only the
existing non-privileged updater check, download, cancel, snapshot, and
subscription surface. Installation, relaunch, Capture, System Proxy, and TUN
mutation remain unavailable through the bridge.

Protocol 39 makes every Helper install, repair, and removal command carry one
bounded UUID operation identity. The resulting Settings snapshot returns that
identity with its Rust-admitted revision and pending/finalizing/terminal state,
so reconnecting or remounted clients accept only the matching terminal result.
The UUID is correlation metadata, never authorization material or a Web-owned
Helper lifecycle.

Protocol 40 adds `recovery-required` to both the TUN Helper and Capture
capability availability enums. Unsafe, foreign, or ambiguous development
installation identity now survives Runtime and Web projection without being
collapsed into generic build/platform unavailability or admitting blind
repair.
