# Mish Repository Map

Use paths relative to the Mish repository root. Read the authoritative document
before changing the corresponding boundary; these files are the source of truth,
not this map.

## Historical contract

The design was established as a transcript-first, non-privileged system-test
architecture:

- Issue #326 introduced the stateful, test-only `SimulatedHost`, real Rust/
  RPC/React execution path, logical time, semantic transcripts, structural
  privacy, and production exclusion.
- Issue #328 extended the same model to Internal TUN package, enrollment,
  Helper/Core, Capture, compensation, restart, ownership, and recovery cases.
- Issue #329 added the separate read-only macOS platform recorder/compiler for
  parser and adapter calibration, with synthetic checked-in fixtures and a raw
  quarantine that never enters the repository.
- Issue #330 made the Rust scenarios plus authenticated RPC and React journey the
  ordinary application-test path and kept `mock-bridge` narrow.

The August 2 discussion explicitly asked whether every incident and decision
had been recorded through this abstraction and converted into Mock data. The
answer is a requirement: every changed semantic effect needs a bounded
invocation/result transcript and deterministic replay/model coverage; raw real
TUN/DNS/route/traffic evidence is prohibited from becoming a mock.

## Read first

- `docs/architecture/transcript-driven-system-tests.md` — complete
  SimulatedHost, scenario, transcript, privacy, exclusion, and evidence-boundary
  contract.
- `docs/quality/macos-platform-transcript-fixtures.md` — real macOS capture,
  quarantine, compile, privacy review, fixture replay, and abort rules.
- `docs/architecture/mihomo-controller-integration.md` — Controller ownership,
  bounded observations/mutations, transport, and fixture conventions.
- `docs/architecture/cross-platform-product-authority.md` — shared authority
  and platform capability boundaries.
- `docs/architecture/frontend-platform-boundary.md` — what Web may project and
  which effects belong to native/Rust adapters.
- `docs/architecture/state-machine-kernel.md` and
  `docs/architecture/state-lifecycle-race-audit.md` — lifecycle, cancellation,
  stale completion, and authority rules.

## Implementation map

| Concern | Current entry points |
| --- | --- |
| Real Runtime and application authority | `crates/runtime`, `crates/state-machine`, `crates/desktop-bridge`, `crates/profile` |
| macOS platform effects | `crates/platform-macos` and its narrow modules/tests |
| Shared transcript-driven host | `crates/simulated-host` |
| Browser cross-layer journey | `apps/web/src/system-tests`, `apps/web/vitest.simulated-host-browser.config.ts` |
| Transport-only mock boundary | `packages/mock-bridge`, `packages/rpc-client` |
| Real macOS recorder/compiler | `scripts/macos-platform-transcript.ts` |
| Checked platform fixture | `docs/quality/fixtures/macos-platform-transcripts/` |
| Simulated-host exclusion | `scripts/simulated-host-exclusion.test.ts` |
| macOS transcript exclusion | `scripts/macos-platform-transcript-exclusion.test.ts` |
| Documentation/authority gates | `scripts/check-*.ts`, `docs/architecture/` |

## Current bounded commands

Run from the repository root:

```sh
# Rust scenarios and the real React Browser Mode journey
pnpm test:application:simulated-host

# Exact Internal TUN maintenance contract when affected
pnpm test:rust:internal-tun-maintenance

# Unit and script tests, including transcript/exclusion checks
pnpm test:unit
pnpm check:simulated-host-exclusion
pnpm check:macos:transcript-exclusion

# Full proportional PR gate
pnpm check:pr
```

For real macOS parser/adapter calibration, follow the quarantine procedure in
`docs/quality/macos-platform-transcript-fixtures.md` and use only:

```sh
pnpm macos:transcript:record -- --output-root <unique-ignored-quarantine>
pnpm macos:transcript:compile -- --input-root <quarantine> --fixture-id <id> --source real-tart --fixture-out <fixture.json> --privacy-diff-out <privacy.md>
pnpm macos:transcript:abort -- --output-root <quarantine>
```

Never inspect raw quarantine output from the host, and never leave it behind
after successful compile or abort.

## Required evidence shape

For a changed boundary, retain a compact matrix with:

| Field | Required content |
| --- | --- |
| Effect | Closed semantic invocation/effect kind |
| Return | Closed result, failure, timeout, cancellation, or partial observation |
| Owner | Real adapter seam and real authority that consumes it |
| Recording | Transcript/fixture/model and schema version |
| Use case | Deterministic scenario and assertion |
| Privacy | Structural fields/bounds and rejection test |
| Exclusion | Test-only/build-graph check |
| Limit | What this evidence cannot prove |

The semantic transcript is allowed to contain only bounded synthetic identity,
scope/operation/revision correlation, effect ID, logical time, closed effect
kind, and closed result kind. Browser failure reports are bounded semantic
reports; they must not dump raw host state.

## Required scenario principles

- Share one mutable synthetic model across adapters; later observations must
  see earlier mutations.
- Use logical time, owned tasks, cancellation, finalizers, bounded injected
  failures, and explicit restart/replacement—not sleeps or tolerance windows.
- Exercise real product machines and real RPC/client contracts. Keep product
  DTOs unchanged unless a minimal evidence-backed seam is unavoidable.
- Assert authority, lifecycle, correlation, cleanup, compensation, and terminal
  outcomes. Do not assert production shell-command ordering from Runtime tests.
- Keep simulated evidence separate from platform calibration and hands-on
  packaging/privilege/network/packet-flow claims.
