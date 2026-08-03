# Transcript-driven non-privileged system tests

## Purpose

`SimulatedHost` is the repository-owned, test-only host for deterministic
system scenarios that must retain Mish's real application authorities. It
replaces only effects behind existing Profile/Core, Capture platform, Capture
journal, and Core Runtime adapter seams. Across the initial-conflict and TOCTOU
scenarios the real `MihomoActivationManager` performs validation, both
managed-listener checks, candidate preparation and rollback; a test-build-only
listener host supplies the synthetic ownership observation and bounded
finalizer effects. The Rust Runtime, Profile activation coordinator, Capture
reconciliation state machine, authenticated RPC server, semantic Notification
Center, generated product contracts, RPC clients, and React command feedback
remain in the execution path.

The first scenario is the vertical slice that justifies the host. A real Web
System Proxy control launches while Capture is Off, a foreign owner holds
`127.0.0.1:7890`, and Profile/Core preparation is deliberately slow. The first
cheap ownership check publishes the existing typed listener-conflict
notification immediately. The operation remains Pending while its owned task
is cancelled and reaped, cleanup and authority reconciliation run, and its
finalizer completes. Duplicate input cannot admit competing work, and Web
loading clears only when the matching authoritative terminal snapshot arrives.
A second scenario schedules a new foreign owner between the first check and
the commit-boundary check and proves that Applied is never published.

The System Proxy transaction scenario drives the same real application
coordinator directly for model/property and failure-injection coverage, then
uses authenticated loopback RPC and real Chromium for cross-surface evidence.
Pending remains authoritative while modeled propagation is incomplete;
native/RPC snapshots, semantic notifications, RPC results, and React loading
all settle from the matching real Capture terminal operation. Browser control
routes only advance logical time or request the closed cancellation, audit, and
replacement controls required by those scenarios.

`pnpm test:application:simulated-host` is the bounded repository entry point.
It runs every simulator model and authenticated-RPC test with one Rust test
thread, then starts the feature-gated harnesses and runs the React journey in
Vitest Browser Mode. The browser journey covers early managed-port notification
with delayed cleanup, commit-time ownership drift, confirmed rollback,
Recovery Required, Helper install and repair projection, cancellation, and
Runtime replacement. Rust and client acceptance tests retain the wider stale,
equal, duplicate, reconnect, and replacement matrices; the browser journey also
unmounts and remounts during Pending and proves an old equal-target completion
cannot replace the new authority.

The harness selector is a closed environment enum. Its control server accepts
only the fixed synthetic control key and scenario-specific logical-time,
cancellation, audit, or replacement actions. Evidence reads the already-recorded
host observation and real Capture projection without issuing a new Runtime audit,
so collecting evidence cannot consume a failure occurrence or alter lifecycle
state.

## Model, scenarios, and logical time

One `Arc`-shared in-memory model backs every adapter in a scenario. Effects
mutate endpoint ownership, Core phase, preparation phase, Capture state, and
journal state; later observations read those mutations. This is a stateful
model, not a sequential cassette and not a list of canned call responses.

The System Proxy slice adds one closed synthetic active service with complete
typed HTTP, HTTPS, SOCKS, PAC, auto-discovery, authentication, and bypass
state. Its built-in baselines cover disabled, enabled manual, disabled but
populated, reversible PAC, reversible auto-discovery, authenticated, and
incomplete configurations. Fixed `.invalid` values make exact journaling and
restoration observable in Rust without admitting user-derived service names,
hosts, URLs, or credentials to the scenario or transcript schemas.

The model keeps applied state separate from observable state. `apply_service`
performs a bounded semantic field transaction against shared state, and each
completed field boundary can fail after mutation so the real Capture
implementation must compensate from its real journal. These semantic fields
are not assertions about `networksetup` command ordering. Successful writes
may remain unobservable until explicit logical time advances; the real Capture
confirmation loop first sees the stale state, retries, and then accepts only
the propagated observation. Scheduled active-service or proxy changes cancel
pending propagation and become unrelated drift.

Process-termination restart drops the process-owned activation coordinator,
Capture reconciler, Runtime, and application host before rebuilding them over
only the simulated platform and journal state. Restart tests then exercise the
production restart audit or command path: an observed managed state can be
completed idempotently, an unrequested owned state is restored, and unrelated
drift remains untouched as Recovery Required. A separate concurrent replacement
helper keeps the old Runtime alive only for stale-completion coverage. Neither
desired state nor journal presence is accepted without a fresh model observation.

Scenario input contains only closed synthetic initial state, logical-time
ownership changes, and occurrence-bounded injected failures. Logical time
advances explicitly. Owned tasks wait on deterministic notifications, use the
production cancellation token, and run production finalization ownership.
Tests never use wall-clock sleeps or timing tolerances to decide a lifecycle
result.

Every adapter effect must be declared by the closed `EffectKind` vocabulary.
An undeclared effect, out-of-range schedule, unbounded failure occurrence, or
transcript overflow returns a typed test failure. There is no implicit success
fallback. Extensions for later scenarios add the smallest new state,
effect/result kind, and adapter behavior needed by an application journey;
they do not introduce a generic operating-system emulator or a second product
lifecycle.

## Internal TUN maintenance slice

The Internal TUN slice uses the same shared model for package artifacts,
installation enrollment, Helper/Core process state, service/socket generation,
TUN/route/DNS ownership, Capture, and an explicitly separate unrelated owner.
It drives the production versioned `PackageMachine`, `TunHelperController`,
`CaptureReconciler`, enrollment/key-continuity operations, maintenance journal
and recovery decision. Only the privileged effects beneath those boundaries are
synthetic.

The closed v1/v2 artifacts use fixed opaque identities and 64-character digest
values. They can prove exact admission, identical reinstallation, upgrade,
downgrade rejection, receipt/enrollment continuity, dual-proof rotation,
lost-key reset authorization, compensation, restart observation, and complete
uninstall without representing a package path, profile, configuration, private
key, credential, or host network value. A healthy initial package is seeded as
an active Mish-owned TUN in the real Capture machine; lifecycle commands must
perform the real Capture handoff before the package machine accepts work.

Failure injection occurs at every maintenance journal boundary and is expressed
as semantic failure kinds such as cancellation, disk exhaustion, interrupted
copy, process exit, artifact replacement, stale completion, cleanup failure,
or a runner panic. Clean failures drive the real compensation state; ambiguous
ones remain non-terminal until the real recovery decision observes the shared
model after restart. Repaired and uninstalled Mish-owned fields never mutate
the modeled unrelated files, service, process, route, DNS, or key.

An authenticated loopback-RPC test composes the real Settings command and
notification path with this model. It proves Pending and finalizing lifecycle
projections, lifecycle-lock serialization of a duplicate command, an early
typed Capture failure with the permitted recovery action, and unpinned or
resolved terminal records. This is application/semantic evidence only; it does
not invoke a desktop driver or a privileged macOS component.

## Semantic transcript

The transcript has a schema version and a fixed event limit. Capture operation
ID and admitted revision come directly from the real Capture machine. Its
opaque authority/scope and the attached Runtime instance are mapped by first
observation to closed synthetic identities, so replacement remains visible
without admitting UUIDs or addresses. Each event records only:

- synthetic authority and runtime identities;
- scope epoch, operation ID, and admitted revision;
- effect ID and logical time;
- a closed semantic effect kind and closed result kind.

Assertions target admitted authority, lifecycle phase, operation correlation,
cleanup/finalizer completion, and terminal semantics. Adapter calibration tests
may separately prove that a production adapter and its simulated counterpart
classify the same product-level result. Scenario assertions must not depend on
production shell-command ordering.

The separate macOS platform transcript fixture described in
[`../quality/macos-platform-transcript-fixtures.md`](../quality/macos-platform-transcript-fixtures.md)
calibrates real `route`/`networksetup` output against the production
`MacOsCommandRunner` parser and adapter. Its checked-in fixture is fully synthetic,
and its runner matches closed request kinds rather than enforcing capture order.
It does not replace this semantic model or make raw command order observable to
Runtime/Capture tests.

## Structural privacy

Privacy is an admission rule, not a redaction pass. Scenario and transcript
schemas do not have arbitrary string, raw observation, or byte fields. Their
Serde inputs reject unknown fields and their collections are bounded.
Schema/privacy tests reject Profile or configuration bytes, subscriptions,
nodes, credentials, tokens, private keys, user paths, raw process output, raw
platform observations, unrelated route or DNS state, traffic, and host/process
inventory. The fixed endpoint and closed synthetic identifiers are contract
data, not observations copied from a real machine.

The harness authentication token and control key are fixed synthetic test
values used only by the Browser scenario. They are intentionally excluded from
the transcript and from all production package graphs.

On a browser assertion failure, the test emits one bounded semantic report: the
assertion context, selected scenario and logical time, at most the final 32
semantic transcript events, and a terminal authority projection containing only
closed synthetic identity, Capture/Core phase, System Proxy/TUN/Helper state,
and the final eight semantic notifications. It contains no raw host observation,
profile/configuration data, path, credential, test key, or real authority UUID.

## Production exclusion

The simulator package is `publish = false`, and its control-server binary
requires the `scenario-harness` feature. Its listener-host and correlation
inspection seams are separately feature-gated and disabled in product package
graphs. No production Rust package depends on the simulator. Web references
are confined to the system-test source directory and a dedicated Vitest
Browser configuration. A checked build-policy test walks Cargo metadata plus
release, alpha, Internal TUN, signed, updater, desktop, mobile, and Web build
inputs and fails if the test graph becomes reachable.

This keeps the scenario control API, synthetic identities, test
authentication, transcript implementation, and simulated adapters absent from
production, alpha, Internal TUN, signed, updater, desktop/mobile, and public
packages. Adding a simulator dependency to a product target is a contract
change, not a convenient reuse.

The build-policy test also rejects scenario controls, test keys, synthetic
identity/transcript internals, harness features, and test correlation seams from
desktop/mobile inputs, Internal Alpha packaging, signed and updater scripts,
public-release checks, and CI artifact workflows. The dedicated Browser config
is not imported by any production Vite entry.

## Evidence boundary

This evidence proves deterministic application orchestration and contract
projection with host effects replaced at existing seams. It does **not** prove:

- application packaging or resource layout;
- `launchd` behavior or administrator authorization UI;
- desktop WebView bootstrap;
- code signing, notarization, or updater installation;
- real System Proxy, DNS, route, or network propagation;
- real Mihomo/Helper/Core process behavior;
- TUN setup or packet flow.

Those claims remain owned by their packaging, privileged-host, native UI,
signed-release, real-network, and packet-flow acceptance layers. SimulatedHost
results must not be cited as evidence for them.
