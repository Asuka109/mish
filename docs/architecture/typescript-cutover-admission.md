# TypeScript cutover admission record

Status: admitted for planning only. This record is the contract for the one
breaking production cutover described below; it is not permission to merge a
partial runtime, ship a package, deploy a service, use credentials, or change a
host, device, network, VPN, or TUN state.

This record is based on the accepted P1-P5 admission evidence at the Wave 3B
baseline `dev@bc93b599` (the P6 worktree was dispatched from
`dev@8e97ca4c`). P0-P5 are prerequisites. POC code is evidence only and is
never a production dependency.

## Decision and non-negotiable cutover rule

The product makes one cumulative, one-shot architecture cutover before launch:

```text
contract-first oRPC + XState v5 + TanStack Query + pinned TanStack Store wrapper
                                 |
                          one cumulative branch
                                 |
       delete Tauri, Rust Core, Cargo/Rust toolchain, custom RPC/state machine,
       parity, compatibility, fallback, and dual-write paths in the same switch
```

No gradual, incremental, strangler, feature-flag, shadow, dual-write, fallback,
or old/new protocol rollout is permitted. CUT-01 through CUT-05 may prepare
isolated changes, but their production branches are not merged independently.
Only the cumulative branch that includes CUT-06 deletion and passes CUT-07 may
be proposed for merge. A maintainer must give a new confirmation-only
acceptance before that destructive merge; this P6 record itself authorizes
planning, not the merge.

The delivered architecture must have no Rust Core, no Rust/Cargo compilation toolchain,
no Tauri shell, no custom JSON-RPC, no Mish-owned general
state-machine runtime, no long-term Rust parity mode, no old-protocol adapter,
no fallback path, and no dual write. TypeScript/XState owns Core and domain
logic. Kotlin, Swift, or Objective-C may own only an irreducible platform effect
behind an existing narrow effect boundary, with bounded invocation/result
transcripts and deterministic replay or simulated acceptance. A native adapter
must not become a second product authority.

## Accepted dependency and artifact versions

The following values are exact admission pins. A drift in either a manifest or
the lockfile rejects admission; a compatible-looking range is not accepted.

| Surface                                                                                         | Exact accepted version | Evidence and scope                                                                 |
| ----------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| oRPC public packages (`@orpc/client`, `@orpc/contract`, `@orpc/server`, `@orpc/tanstack-query`) | `1.15.0`               | P0 lock and P1 `poc/orpc` manifests/lock; oRPC is ESM-only                         |
| XState                                                                                          | `5.32.5`               | P0 lock and P2 `poc/xstate` manifest                                               |
| `@xstate/react`                                                                                 | `6.1.0`                | P0 lock and P2/RN manifests                                                        |
| TanStack Query (`@tanstack/query-core`, `@tanstack/react-query`)                                | `5.101.4`              | P0 lock and P3/P4/P5 manifests                                                     |
| TanStack Store core (`@tanstack/store`)                                                         | `0.11.1`               | P0 lock and P3/P5 manifests                                                        |
| React / React DOM                                                                               | `19.2.7`               | P0 lock; React DOM is Electron-only                                                |
| Electron                                                                                        | `43.4.0`               | P0 lock/P4 manifest and P4 archive verifier                                        |
| React Native                                                                                    | `0.87.0`               | P0 lock/P5 manifest; New Architecture and Hermes are required                      |
| Node.js                                                                                         | `>=22.13.0`            | P0 POC engine floor; production hosts must publish a separately reviewed floor     |
| TypeScript                                                                                      | `7.0.2`                | POC compiler pin; production cutover must retain a frozen compiler in its lockfile |
| Vite / Vitest                                                                                   | `8.2.1` / `4.1.10`     | Electron fixture build/test tools only                                             |
| RN Babel core/runtime                                                                           | `7.29.7`               | P0c exact host-toolchain consumers                                                 |
| RN Community CLI / Android CLI                                                                  | `20.2.0`               | P0c exact host-toolchain consumers                                                 |
| RN Babel preset, Codegen, Gradle plugin, Metro config, Metro transformer                        | `0.87.0`               | P0c/P0e exact host-toolchain consumers                                             |
| `ws`                                                                                            | `8.21.1`               | P0 lock fixture transport only                                                     |

### Artifact evidence

| Evidence                    | Exact accepted observation                                                                                                                                                                       | Limit                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| P4 Electron runtime archive | Darwin ARM64 Electron `43.4.0`, SHA-256 `827f9f182566f46846377575b51c547b9926b111637313a373b6f717462aebac`; `poc/electron/src/archive.ts` verifies regular-file shape, digest, and ZIP integrity | No Windows/Linux, Intel macOS, signing, notarization, updater, credentials, or release claim             |
| P4 mounted application      | Worker completed six consecutive real mounted-DMG passes; coordinator completed a fresh `6/6` pass in `41.82s`, with no residual process or mount                                                | Credential-free fixture only; no System Proxy, VPN, TUN, Core, or remote-network claim                   |
| P5 Android build            | React Native `0.87.0`, New Architecture, Hermes, `arm64-v8a,x86_64`, debug APK built by `node poc/rn/scripts/build-debug-apk.ts`                                                                 | Debug fixture only; no production signer, release, store, iOS, or physical-device claim                  |
| P5 renderer                 | Independent root-free `emulator-5558` smoke reached `RN_ADMISSION_OK`; owned process/serial/port cleanup passed                                                                                  | Emulator renderer/process evidence only; no permission, VPN/TUN/Core, packet-flow, or real-network claim |
| P1/P2/P3 transcripts        | Schema-versioned bounded semantic transcripts with synthetic IDs, logical time, closed effect/result enums, and structural privacy checks                                                        | Simulated/in-memory effect evidence; not a real remote endpoint or privileged host observation           |

## Target platform boundaries

The target is one TypeScript application contract with platform-specific
composition. The current Tauri/Rust graph is not an allowed target graph.

| Target               | Owns                                                                                                                                       | May consume                                                                                             | Must not own or import                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Web                  | React presentation, React Router, transient local state, Query observers, Store UI projections                                             | Contract-first oRPC WebSocket/Event Iterator client; XState actors; shared tokens/UI                    | Node/Electron/RN globals, native effects, Tauri, Cargo/Rust, a custom JSON-RPC envelope, remote snapshots in Store                           |
| Electron             | Hardened main/preload/renderer composition and an Electron `MessagePort` adapter                                                           | Same oRPC contracts, XState actors, Query, framework-agnostic Store plus `useSyncExternalStore` adapter | Renderer Node access, `nodeIntegration`, unisolated IPC, a second RPC protocol, credentials in renderer, Tauri, Rust Core                    |
| React Native Android | RN New Architecture/Hermes renderer and narrow TurboModule/native effect adapters                                                          | Same contracts, XState, Query core, and the pinned framework-agnostic Store wrapper                     | React DOM or `@tanstack/react-store` in RN/shared graphs, DOM globals, Tauri, Rust Core, a Kotlin product state machine, fallback/dual-write |
| Host-native adapter  | Kotlin, Swift, or Objective-C may own only an irreducible permission, service, VPN/TUN, socket, process, filesystem, or OS callback effect | Typed request/response effect seam and the owning XState actor                                          | Product lifecycle authority, remote state cache, UI store writes, unbounded/raw observations, an unrecorded side effect                      |

WebSocket/Event Iterator is the shared Web/RN transport policy where the host
provides it. Electron uses the oRPC MessagePort adapter in the main/preload
boundary. P1's in-memory channels prove adapter policy; P4 proves the real
Electron MessagePort handshake from the mounted fixture; P5 proves that RN/Hermes
can resolve the ESM contract and cancellation seams. None of those observations
is evidence for a remote service, a real user credential, or a network effect.

## Contract-first oRPC and session policy

`poc/orpc/src/contract.ts` is the P1 shape: procedure paths and payloads are
declared once, and the client/server use official oRPC adapters. The cutover
must preserve this policy in production; it must not write a second envelope or
translate an old JSON-RPC wire format.

| Policy                   | Required contract                                                                                                                                                                                                                                | P1/P4 evidence                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Authentication           | Handshake authenticates before application calls; unauthorised handshakes are typed rejection. Tokens never enter transcripts, UI stores, or failure reports.                                                                                    | `poc/orpc/tests/policy-transport.test.ts` rejects `wrong-token`; P1 README privacy boundary                    |
| Version negotiation      | Handshake carries exact protocol version `1`; mismatch is rejected before current state is accepted. A future protocol bump must update the contract, fixtures, and acceptance together.                                                         | P1 test rejects peer version `2`; Electron fixture uses `FIXTURE_PROTOCOL_VERSION = 1`                         |
| Session generation       | A reconnect must return a strictly newer positive session generation and a fresh baseline; reusing generation `3` is stale.                                                                                                                      | P1 reconnect test accepts `1 -> 2` and rejects `3 -> 3`                                                        |
| Correlation              | Every unary/event operation has a bounded synthetic correlation ID; output must match operation, correlation, generation, and event sequence.                                                                                                    | P1 `poc-0001`…`poc-9999` fixtures and stale identity/sequence tests                                            |
| Stale-response rejection | Older correlation, generation, sequence, connection, or parent epoch cannot mutate current state. “Different session” alone is not proof of freshness.                                                                                           | P1 stale unary/event tests; ADR-0001 and race-audit acceptance rule                                            |
| Deadline                 | Every request has a positive bounded deadline; default POC maximum is `1000ms`, invoke default is at most `250ms`, and caller abort is propagated to the peer. No unbounded pending request is admitted.                                         | P1 manual scheduler/deadline and AbortSignal tests; P4 port `8000ms`, renderer `10000ms`, quit `5000ms` bounds |
| Message size             | The negotiated ceiling is validated in `[128, 1048576]` bytes, only decreases after handshake, applies before send and on receive, and disconnects an oversized channel. POC clients use `16 * 1024` and the Electron fixture negotiates `4096`. | P1 bounded channel and `256/257` rejection tests; P4 fixture constants                                         |
| Reconnect/recovery       | Disconnect rejects or marks pending work unknown, closes subscriptions, and requires a fresh authenticated baseline before Query/XState projection resumes. Reconnect never implies success.                                                     | P1 MessagePort recovery and Event Iterator cleanup; P2 RPC actor reconnect; P5 WebSocket/iterator replay       |
| Event Iterator           | Iterator values are routed only to a Query cache or an XState actor; `return()` is idempotent and cleanup is observed on abort, unmount, disconnect, and replacement.                                                                            | P1 event iterator; P3 `consumeEventIterator`; P5 AbortSignal replay                                            |
| Transcript               | Bounded schema-versioned invocation/result evidence admits only synthetic IDs, authority/session/revision metadata, logical time, and closed result kinds; no token/body/URL/raw wire/platform output.                                           | P1/P2/P4/P5 transcript parsers and privacy tests                                                               |

## XState v5 lifecycle ownership

XState v5 actors and statecharts own domain lifecycle and complex workflow
authority. There is no Mish-owned generic runner or state-machine kernel. Each
actor carries an authority/generation/operation/revision correlation, invokes a
narrow effect, accepts only a matching result, cancels and joins owned work,
and exposes explicit failure, superseded, recovery, and finalizer outcomes.

| Actor       | Required states and transitions                                                                                                                                                   | Required effects/evidence                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime     | `stopped -> starting -> running`; `STOP/CANCEL -> stopping -> stopped`; `REPLACE -> replacing -> starting`; `DISPOSE -> done`                                                     | Start/stop/dispose cancellation, generation replacement, stale completion rejection, owned finalizer                                                          |
| Core        | `idle -> launching -> ready`; launch failure -> `failed`; `RECOVER` starts a new generation; stop/dispose joins process observation                                               | Core launch/stop/dispose, typed failure and recovery; no Rust Core or unmanaged child authority                                                               |
| VPN-TUN     | `stopped -> requesting/starting -> observing -> running`; `STOP -> stopping -> cleanup -> stopped`; failed cleanup -> `failed/recovery-required`                                  | Permission/service/TUN/socket effects only through native seam; operation/session/revision guard, cleanup transcript, simulated replay; no POC network effect |
| Profile     | `inactive -> activating -> confirming -> active`; cancel/deactivate -> rollback/deactivating; failed rollback -> `recovery-required`                                              | Activation is not success until authoritative observation; stale observation cannot commit; compensation and restart evidence                                 |
| Capture     | `off -> applying -> reconciling -> applied`; disable -> `restoring -> off`; failed apply/restore -> explicit `failed/recovery-required`; repair is explicit                       | Applied requires fresh observation; one operation/correlation; no client prediction or second lifecycle authority                                             |
| Settings    | `disconnected -> connecting -> authenticating -> baselining -> connected`; refresh failure -> `failed`; retry reconnects; dispose -> `done`                                       | Baseline is a replacement barrier; stale generation/revision is ignored; no optimistic remote snapshot in Store                                               |
| Updater     | `idle -> checking -> verifying -> available`; commit -> `committing`; cancellation has a finalizer; commit/cleanup failure -> `recovery-required`; retry starts a fresh operation | Candidate identity, cancellation cutoff, bounded cleanup, restart re-verification, no install authority inferred for unsupported platforms                    |
| RPC session | `disconnected -> connecting -> authenticating -> connected-stale -> connected-current`; close -> `reconnecting`; exhausted attempts -> `disconnected`; dispose -> `disposed`      | Auth/version/generation/correlation/deadline/message bound/reconnect policy above; retire old transport and subscription before publishing new authority      |

The P2 actor fixture covers Runtime, Core, Profile, Capture, Updater, VPN,
Settings, and RPC domains with `xstate@5.32.5`, `fromPromise`, cancellation,
replacement, stale completion, failure, recovery, and bounded semantic
transcripts. It is admission evidence, not a reason to retain the old Rust
state-machine implementation.

## Query, Store, and UI state boundary

| State category                                                                           | Sole owner                                                                                      | Allowed projection                                                                 |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Remote resource snapshots, query freshness, invalidation, bounded retry, streamed chunks | TanStack Query (`@tanstack/query-core`/`@tanstack/react-query`) through official oRPC utilities | React/RN observers and selectors; Event Iterator chunks enter Query or XState only |
| Domain lifecycle, command pending/terminal, cancellation, replacement, recovery          | XState v5 actor                                                                                 | Typed actor snapshot and operation-keyed UI projection                             |
| Lightweight cross-component UI state (filters, view-local selection, presentation mode)  | Pinned framework-agnostic `@tanstack/store` core behind the Mish `useSyncExternalStore` wrapper | Web and RN/Hermes renderer-neutral adapter; batching/remount cleanup is tested     |
| One-component transient state (focus, animation, input draft)                            | React local state                                                                               | Never persisted as application authority                                           |

The Store wrapper may not contain remote snapshots, credentials, profile/config
bytes, or lifecycle truth. The official `@tanstack/react-store` adapter is
ReactDOM-only and is therefore forbidden in RN/shared graphs. P3 proves the
framework-agnostic Store, `useSyncExternalStore`, selector equality, batching,
derived values, unsubscription, and remount behavior. P4 proves a real React
DOM renderer through Electron; P5 proves the same adapter in the RN/Hermes
renderer.

## Static denylist and production exclusion

The following are hard denylist entries for the final production graph. The
names may appear in this admission record, historical evidence, or a bounded
cutover test fixture only; they must not be reachable from a Web, Electron, RN,
native-adapter, package, build, release, or CI production graph after CUT-06.

| Denylist class           | Static entries to delete or reject                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust/Cargo               | `Cargo.toml`, `Cargo.lock`, `.cargo/**`, `rust-toolchain*`, `rustfmt.toml`, `clippy.toml`, `crates/**`, `mobile-core/**`, `*.rs`, `cargo`, `rustc`, `clippy`               |
| Tauri                    | `apps/desktop/src-tauri/**`, `apps/mobile/src-tauri/**`, `tauri`, `@tauri`, `tauri-plugin-*`, generated Tauri permissions/configs                                          |
| Custom RPC               | `packages/rpc-client/**`, `packages/bridge-protocol/**`, `crates/desktop-bridge/**`, handwritten `JSON-RPC`, `json-rpc`, `json_rpc`, old bridge protocol adapters          |
| Custom lifecycle runtime | `crates/state-machine/**`, `mish_state_machine`, repository-owned general state-machine runner/kernel, duplicated lifecycle reducer                                        |
| Parity/compatibility     | Rust parity/golden parity mode, old-protocol adapter, compatibility bridge, migration fallback, `fallback`, `dual-write`, shadow writes, feature-flagged old/new authority |
| POC leakage              | `poc/**` imports or workspace dependencies from `apps/**`, `packages/**`, release/build inputs, native adapters, or CI production jobs                                     |

The POC workspace remains a private, `publish = false` admission fixture. Its
runtime source may be run only through the POC commands and must never be
imported, copied into a production package, resolved through `.pnpm`, resolved
through a private `/dist/` path, or used as a fallback/compatibility path.
P1-P5's own static tests reject private resolvers and P3/P5 reject DOM and
host-global leakage. The final CUT-07 graph walk must fail closed on any
denylist entry or `poc/**` production edge.

## Evidence-to-conclusion traceability

| Evidence ID | Source                                                                                                                                                                  | Accepted conclusion                                                                                                                               | Boundary / limitation                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| E-P0        | `progress.md` Wave 3B table; `poc/pnpm-lock.yaml`; all `poc/*/package.json`                                                                                             | Exact dependency pins and frozen POC install are reproducible                                                                                     | Does not admit production package graph                                                              |
| E-P1        | `poc/orpc/README.md`; `poc/orpc/src/contract.ts`; `poc/orpc/src/transport.ts`; `poc/orpc/tests/policy-transport.test.ts`                                                | Contract-first oRPC, WebSocket/Event Iterator, MessagePort, auth/version/generation/stale/deadline/size/correlation/cancellation/reconnect policy | In-memory peer; no remote service or credential storage                                              |
| E-P2        | `poc/xstate/src/actors.ts`; `poc/xstate/src/transcript.ts`; `poc/xstate/test/admission.test.ts`                                                                         | XState v5 actor lifecycle and bounded cancellation/replacement/failure/recovery semantics                                                         | Closed deterministic effects; no host effect                                                         |
| E-P3        | `poc/query-store/src/event-iterator.ts`; `query.ts`; `store.ts`; boundary/query/store/renderer tests                                                                    | Query owns remote state, Event Iterator has only Query/XState sinks, Store wrapper is framework agnostic and renderer neutral                     | Package tests do not claim a renderer; P4/P5 close renderer gates                                    |
| E-P4        | `poc/electron/test/boundary.test.ts`; `electron-admission.test.ts`; `poc/electron/scripts/electron-fixture.ts`; `poc/electron/src/archive.ts`; progress ledger          | Hardened Electron launch, MessagePort handshake, React DOM Store adapter, clean mounted-DMG exit, exact archive digest                            | Darwin ARM64 credential-free fixture only; no release/signing/network/system effect                  |
| E-P5        | `poc/rn/README.md`; `poc/rn/test/static-admission.test.ts`; renderer/capability/replay tests; `poc/rn/scripts/check-admission.ts`; `smoke-emulator.ts`; progress ledger | RN 0.87 New Architecture/Hermes, public ESM resolution, Store renderer evidence, dual-ABI debug build, root-free emulator renderer and cleanup    | No iOS, physical device, production signing, permission, VPN/TUN/Core, packet-flow, or network claim |
| E-SYS       | ADR-0001; `mish-transcript-driven-system-tests` skill; `docs/architecture/transcript-driven-system-tests.md` and evidence-boundary docs                                 | Native effects must use narrow effect boundaries, bounded transcripts, replay/simulated acceptance, and explicit evidence limits                  | Real-host acceptance remains separate and is not authorized here                                     |

An evidence ID is a claim pointer, not an approval shortcut. POC tests prove
the stated contract and only the stated contract; no simulated result may be
rephrased as production packaging, WebView bootstrap, authorization UI,
signing/notarization, updater installation, real network propagation, Core
behavior, TUN setup, or packet flow.

## Exact cumulative cutover worker packets

All packets use the existing Wave 3B envelope: isolated branch/worktree,
`gpt-5.6-luna/max`, Chinese reporting, confirmation-only acceptance,
final-only escalation, no credentials/release/deployment/external-service
writes, and no real system/network/VPN/TUN/Core mutation. A packet may prepare
code in isolation, but no packet may independently merge a production runtime.
The packet scopes below are exclusive; a worker must stop on overlap or an
unlisted generated file.

### Root lock ownership and cumulative reconciliation

CUT-01 through CUT-05 have the same bounded generated-file permission: each
packet may update only the cumulative root `pnpm-lock.yaml` when its exact
dependency changes require it. This permission does not include the POC lock,
an importer unrelated to the packet, a version-range relaxation, or any other
generated file. The packet must preserve every existing importer and the exact
accepted versions.

Root lock changes may enter only the non-production cumulative branch
`codex/typescript-cutover`; no packet branch may merge directly to `dev`. If
parallel CUT-04/CUT-05 work produces lock changes, the cumulative integrator
performs lock conflict reconciliation sequentially: compare exact versions,
retain every importer, resolve one root lock, run the frozen install, and verify
no missing importer before recording acceptance. The frozen-install gate is
`pnpm install --frozen-lockfile`. An unresolved conflict stops the worker; it
cannot be solved by dropping an importer, widening a range, or bypassing the
cumulative branch. CUT-06 remains the final owner of root manifest,
`pnpm-lock.yaml`, and CI cleanup, including removal of obsolete entries after
CUT-01 through CUT-05 are accepted.

| Packet                             | Exclusive scope                                                                                                                                                                                                                                    | Depends on                         | Deliverable and acceptance                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CUT-00 Freeze                      | Read-only coordination; no production file edits                                                                                                                                                                                                   | P6 accepted                        | Record one source/lock SHA, exact pins, target platforms, and packet ledger; reject any partial-merge or rollout plan. Acceptance is a read-only manifest review.                                                                                                                                                                    |
| CUT-01 Contract/session            | `packages/contracts/**`, new `packages/orpc-client/**`, their tests, and bounded generated updates to the cumulative root `pnpm-lock.yaml` for exact packet dependencies only                                                                      | CUT-00                             | Implement one generated oRPC contract and session authority with auth, exact version negotiation, generation, correlation, stale rejection, deadlines, size bounds, Event Iterator cancellation, MessagePort/WebSocket adapters, and reconnect baseline. Typecheck, focused tests, transcript/privacy tests, and no custom JSON-RPC. |
| CUT-02 Domain actors               | New `packages/domain/**`, actor tests, and bounded generated updates to the cumulative root `pnpm-lock.yaml` for exact packet dependencies only                                                                                                    | CUT-01                             | Implement XState v5 actors for Runtime/Core/Profile/Capture/VPN-TUN/Settings/Updater/RPC session with operation/revision/authority guards, cancellation/finalizers, replacement, recovery, and deterministic replay. Reject any custom runner/kernel or second authority.                                                            |
| CUT-03 Query/Store/UI state        | `packages/ui-state/**`, `apps/web/src/**` UI/data projection files, UI tests, and bounded generated updates to the cumulative root `pnpm-lock.yaml` for exact packet dependencies only; no host shell                                              | CUT-01, CUT-02                     | Migrate remote state to Query, lifecycle to actors, UI-only state to the pinned Store wrapper, and Event Iterator sinks to Query/XState. Web renderer journeys, unmount/remount, stale/reconnect, accessibility, and production-graph checks pass; no DOM adapter in RN/shared code.                                                 |
| CUT-04 Electron host               | New Electron host files under `apps/desktop/**` excluding any `src-tauri/**`, host tests/fixture metadata, and bounded generated updates to the cumulative root `pnpm-lock.yaml` for exact packet dependencies only                                | CUT-01, CUT-02, CUT-03             | Deliver hardened sandbox/context-isolated main/preload/renderer with MessagePort oRPC, clean bounded shutdown, and credential-free mounted-DMG fixture evidence. Fresh mounted acceptance passes with no residual process/mount; no release/signing claim.                                                                           |
| CUT-05 RN host/native seam         | New RN host files under `apps/mobile/**` excluding any `src-tauri/**`, Kotlin/Swift/Objective-C effect adapters, transcript/replay tests, and bounded generated updates to the cumulative root `pnpm-lock.yaml` for exact packet dependencies only | CUT-01, CUT-02, CUT-03             | Deliver RN New Architecture/Hermes composition and only irreducible native effect seams. Acceptance passes with a dual-ABI debug build, root-free emulator renderer, bounded effect transcripts/replay, exact cleanup, and no VPN/TUN/Core/network side effect in the admission fixture.                                             |
| CUT-06 Destructive retirement      | All denylist paths, root manifests, final root `pnpm-lock.yaml`, scripts/workflows, and CI cleanup for production graph edges listed in the denylist; no edits to POC evidence                                                                     | CUT-01 through CUT-05 all accepted | In the same cumulative branch, delete Tauri, Rust Core, Cargo/Rust tooling/gates, custom JSON-RPC, custom state-machine, parity, compatibility, fallback, and dual-write paths. Remove old build/release/test references. Static denylist, graph walk, lockfile, typecheck, focused tests, and full proportional gate pass.          |
| CUT-07 Final cumulative acceptance | Read-only verifier and bounded evidence report; no source mutation                                                                                                                                                                                 | CUT-06                             | Verify one branch contains all packets and no partial runtime is merged; run exact Web/Electron/RN renderer gates, transcript/privacy/replay gates, production exclusion, denylist graph walk, and package/build checks. Require maintainer confirmation before merge; do not publish/deploy.                                        |

### Dependency waves and merge barrier

```text
Wave A: CUT-00
Wave B: CUT-01
Wave C: CUT-02
Wave D: CUT-03 || CUT-04 || CUT-05
Wave E: CUT-06        (destructive deletion; one cumulative branch only)
Wave F: CUT-07        (read-only acceptance; maintainer confirmation required)
```

The `||` in Wave D is worker parallelism only. It is not production rollout
parallelism. The merge barrier is closed until every packet is present in the
same cumulative branch and CUT-07 passes. If a packet discovers a missing
effect boundary, privacy gap, generated-file overlap, or unsupported platform,
it reports `blocked`/`needs-info` and does not weaken the gate.

## Admission checklist

- [x] P1-P5 evidence is integrated and mapped to E-P1 through E-P5.
- [x] Exact dependency pins and P4/P5 artifact limits are recorded.
- [x] Web, Electron, RN/Hermes, and host-native effect boundaries are explicit.
- [x] oRPC session, transport, identity, deadline, size, iterator, and recovery policies are explicit.
- [x] XState v5 lifecycle ownership covers Runtime, Core, VPN-TUN, Profile, Capture, Settings, Updater, and RPC session.
- [x] TanStack Query, Store, UI local state, and renderer boundary are explicit.
- [x] Static denylist, POC exclusion, evidence limits, and traceability are machine-checkable.
- [x] CUT-01 through CUT-05 have bounded root-lock ownership with cumulative conflict reconciliation and frozen-install/no-missing-importer acceptance.
- [x] CUT-00 through CUT-07 packets, dependency waves, acceptance, and one-shot merge barrier are explicit.
- [x] No release, deployment, credential, external-service write, or real system/network effect is authorized by this record.
