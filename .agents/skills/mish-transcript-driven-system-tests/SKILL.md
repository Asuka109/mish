---
name: mish-transcript-driven-system-tests
description: Mandatory transcript-first architecture and testing workflow for Mish/mihomo-web-client changes that touch controller or operating-system/platform effects, including System Proxy, TUN, Helper/Core, filesystem, process, socket, service, window, network, DNS, route, native, RPC orchestration, fixtures, mocks, or integration tests. Use it to audit and complete adapter seams, capture bounded calls and returns, compile privacy-reviewed fixtures, extend the stateful SimulatedHost, replay through real Rust/RPC/React authorities, and create deterministic regression use cases before accepting a change.
---

# Mish Transcript-Driven System Tests

This is a mandatory engineering contract for Mish system-boundary work. Apply it
before editing code, and keep applying it whenever implementation reveals a new
platform effect, failure mode, or unrecorded behavior. The goal is to make real
system interaction observable and replayable without moving product authority
into mocks or mutating a developer/CI host.

Read [references/repository-map.md](references/repository-map.md) first, then
read the repository documents it points to. The repository's
`docs/architecture/transcript-driven-system-tests.md` is the detailed behavioral
contract; this skill turns that contract into a mandatory delivery workflow.

## Scope gate

Use this skill for any change that can cross a system boundary or change its
test evidence, including:

- Controller calls, Core/Helper lifecycle, System Proxy, TUN, capture, DNS,
  routes, sockets, listeners, process/service management, files, permissions,
  windows, native APIs, or platform command parsing.
- Rust Runtime/application/coordinator changes that admit, cancel, finalize,
  recover, reconcile, or project those effects through RPC or React.
- Changes to `SimulatedHost`, transcript schemas/recorders/compilers,
  `mock-bridge`, platform fixtures, adapter seams, or production-exclusion
  checks.

For a purely textual, visual, or isolated algorithm change with no boundary or
test-harness impact, state `system-boundary: not applicable` in the work notes
and do not invent a simulator. Otherwise this skill is required.

## Non-negotiable contract

1. Keep the real product authorities in the execution path: Rust Runtime,
   Profile/Core coordinator, Capture authority/state machine, authenticated RPC,
   semantic notifications, generated contracts, and React command feedback.
2. Replace only host effects behind narrow, existing platform/adapter seams. A
   new seam must be the smallest evidence-backed boundary needed by the real
   behavior. Do not add a universal `OperatingSystem` interface, a generic OS
   emulator, a second product lifecycle in TypeScript, or a test-only rewrite of
   the transaction.
3. Represent every changed boundary effect as an invocation/result transcript.
   Use a bounded real platform recording when platform output matters; use a
   closed semantic effect model when the product contract is the thing under
   test. Never leave a new call or return value as an unobserved ad-hoc mock.
4. Turn every discovered bug, rejected decision, recovery path, and meaningful
   race into a named deterministic use case. A passing fake-adapter unit test is
   not sufficient evidence for a cross-layer change.
5. Keep raw observations quarantined and ephemeral. Only bounded, synthetic,
   privacy-reviewed fixtures and semantic transcripts may enter the repository.
6. Prove test-only code is absent from product, desktop/mobile, alpha, Internal
   TUN, signed, updater, and public-release build graphs.

## Required workflow

### 1. Map the boundary before editing

- Preserve and inspect the worktree first: `git status --short --branch`.
- Read the architecture/testing documents in the repository map.
- Trace the actual path as a short chain:
  `UI/command -> authenticated RPC -> application/Rust authority -> state machine -> adapter seam -> host effect -> observation/result -> snapshot/notification -> UI`.
- Search for direct effects in the affected scope (`Command`, filesystem APIs,
  sockets, process/service APIs, platform commands, native/window calls) and
  identify which seam owns each call and return value.
- Write a small boundary matrix before implementation: effect, owning seam,
  invocation/result shape, existing recording or fixture, replay/use case,
  privacy status, production-exclusion check, and missing work.

If a direct host call has no owning seam, stop the feature implementation long
enough to add or document the smallest seam and its evidence plan. Do not hide
the gap behind a broad abstraction or a canned mock.

### 2. Record calls and returns at the boundary

For every changed effect, capture the semantic invocation and outcome, including
success, typed failure, timeout, cancellation, partial observation, and
compensation where applicable. The record must be produced by the abstraction
that the real code uses, not copied from a test assertion.

When real platform output is required to calibrate a parser or adapter:

- Run only the repository's allowlisted recorder inside the explicitly selected
  disposable target. Use fixed programs/arguments, locale, time/output limits,
  and a mode-restricted quarantine.
- Never change System Proxy, DNS, routes, traffic, permissions, or other host
  state merely to collect evidence. Never print, attach, or copy raw quarantine
  data to the host.
- Compile the capture into a closed, versioned, bounded synthetic fixture and a
  privacy diff. Reject unknown fields and secret/credential/config/path/
  process/network shapes structurally; do not rely on after-the-fact scrubbing.
- Replay the compiled fixture through the production adapter/parser and assert
  the normalized semantic result. Raw command order is calibration evidence,
  not a Runtime/Capture business assertion.

When platform capture is unsafe, unavailable, or irrelevant to the product
contract, declare that boundary explicitly and record a closed synthetic
semantic effect model instead. Do not fabricate real-platform evidence. The
model must still record bounded invocation/result events and document what it
does not prove.

### 3. Use one stateful simulated host for workflows

Extend the repository-owned `SimulatedHost` only when the real scenario needs
it. Use one shared in-memory model for all adapters in that scenario. Effects
mutate shared state and later observations read those mutations. Do not use a
sequential cassette, a list of expected calls, or canned return values that
ignore state.

Require all of the following:

- Closed synthetic initial state, logical-time scheduled changes, and bounded
  occurrence-based failure injection.
- Paused/logical time, owned tasks, production cancellation/finalizer ownership,
  deterministic scheduling, and no wall-clock sleeps or timing tolerances.
- A closed effect/result vocabulary. An undeclared effect, invalid schedule,
  unbounded failure occurrence, or transcript overflow fails with a typed test
  error; it never defaults to success.
- A deterministic, bounded, schema-versioned semantic transcript containing
  only closed synthetic identities and the required authority/runtime/scope,
  operation/revision, effect, logical-time, effect-kind, and result-kind data.
- Assertions about authority, lifecycle, correlation, cleanup, compensation,
  and terminal semantics rather than shell-command ordering.

Start scenarios from the real command/application path. For a UI-facing change,
prove at least one real Web/Vitest Browser Mode journey through RPC, Rust
authority, the simulated effects, semantic notification/result, and the React
projection. Keep `mock-bridge` limited to transport/auth/origin/schema/
subscription/cancellation framing and explicit method failures, or make it
consume Rust scenario output; it must not become a second lifecycle authority.

### 4. Close the use-case loop

For each incident or design decision, add a named scenario and assertions for
the behavior that mattered. At minimum choose the applicable cases from:

- happy path, partial observation, typed failure, timeout, cancellation,
  panic/abort, cleanup/finalizer completion, and compensation;
- duplicate/concurrent command admission and serialization;
- stale, equal, duplicate, reconnect, remount, replacement, and restart
  completions/authorities;
- second-check/TOCTOU ownership drift before protected commit;
- recovery-required and retry behavior, including foreign/unrelated ownership;
- parser/adapter malformed, locale, truncation, permission, unexpected-field,
  and bounded-output cases when real platform output is involved.

The test must prove the important ordering and authority semantics without
depending on timing luck. For example, an early conflict notification must be
observable while the real operation remains Pending/Finalizing, cleanup must
finish, duplicate input must not create competing work, and a changed second
ownership check must prevent Applied.

When implementation discovers a new call, return shape, failure, or race, add
the recording/model entry and regression use case before considering the change
complete. Missing recording or missing use case is a delivery blocker, not a
future cleanup item.

### 5. Enforce privacy and production exclusion

Treat privacy as schema admission. Do not admit Profile/config bytes,
subscriptions, nodes, credentials, tokens, private keys, user paths, raw
process output, raw platform observations, unrelated routes/DNS, traffic,
host/process inventory, or arbitrary strings into scenario inputs, transcripts,
fixtures, or failure reports. Add rejection and size-bound tests.

Keep scenario controls, synthetic identities, test keys, transcript internals,
and simulated adapters behind test-only packages/features/configs. Run the
repository exclusion checks and inspect the product build graph. Ordinary CI
must not require root/sudo, Tauri/WebDriver/Tart, a real Core/Helper/TUN, host
network mutation, or external network access.

State the evidence boundary in docs and handoff. Simulated evidence proves
deterministic application orchestration and contract projection with effects
replaced at seams; it does not prove packaging, launchd, authorization UI,
WebView bootstrap, signing/notarization, updater installation, real network
propagation, real Core/Helper behavior, TUN setup, or packet flow.

### 6. Verify and report

Run the narrowest affected tests first, then the bounded cross-layer entry
point, production-exclusion checks, and the proportional repository gate. The
repository map lists current commands. Do not claim completion from a unit test
around a fake adapter alone.

The final handoff must include:

- the boundary matrix and every new/changed recording or fixture;
- the named use cases added, including the real application path exercised;
- privacy/schema and production-exclusion results;
- exact commands and outcomes, with unsupported real-platform claims called out;
- any unresolved gap as `blocked`/`needs-info`, never silently omitted.

## Stop conditions

Stop and report a blocker before merging or declaring done when:

- product logic still calls the host directly without a narrow seam;
- a changed invocation/result is unrecorded or has no deterministic replay/model;
- the test relies on wall-clock timing, call-order cassettes, canned responses,
  or a parallel mock-owned lifecycle;
- privacy admission or production exclusion is unproven;
- the only evidence requires mutating a real host and no proportionate isolated
  acceptance path is available.

Do not weaken assertions to make an incomplete observation look successful.
