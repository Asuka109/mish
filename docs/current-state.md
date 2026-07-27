# Current Repository State

Refreshed 2026-07-27 against `main` at
`014480e9d2ec896781ea4443c6cc44303f16bdfe`.

This page is the short integration checkpoint for maintainers. It summarizes
verified implementation, intentionally unavailable capabilities, current
release evidence, and review findings that still need follow-up. Area-specific
architecture and quality documents remain authoritative for detailed contracts.

Evidence labels on this page have strict meanings:

- **Implemented** means the behavior exists on the reviewed commit and is
  covered by repository tests or accepted delivery evidence.
- **Verified** means the named command or workflow was rerun or read back for
  this checkpoint.
- **Not delivered** means the repository intentionally does not claim the
  capability yet.
- **Review concern** means the reviewed implementation and intended product
  outcome are not yet convincingly aligned. It is not a claim that a fix has
  already landed.

## Verified Review Baseline

- `pnpm check:pr` passed on the reviewed commit: 440 Web tests, 10 RPC client
  tests, 2 mock bridge tests, 77 script tests, and the repository lint, type,
  format, localization, token, documentation, public-release, and runtime-state
  ownership checks.
- `cargo test -p mish-updater` passed all 5 updater contract tests.
- The focused signed-release and Tart TUN script suites passed all 16 tests.
- Recent merged work from PRs #246 through #253 was reviewed together rather
  than as isolated pull requests.
- The required Fast PR gates for the reviewed recent pull requests passed.
- The latest `main` CI push run for this commit failed before either packaging
  job executed a step. This is missing hosted artifact evidence, not a
  successful or failed product package test.

## Implemented

### Runtime and Cross-Surface State

- Rust owns the durable and process-global state required across the desktop
  WebView, Browser Client, native status menu, and reconnecting clients.
  Application snapshots have monotonic ordering, runtime-scoped commands reject
  replaced-runtime completion, capture operations have explicit identities, and
  Profile activation has a typed data-bearing lifecycle.
- Recent Traffic authority is retained on the Rust side. Web pause/resume keeps
  a presentation snapshot while continuing to receive the latest authoritative
  state.
- Web command feedback is keyed by operation and scope instead of relying on
  one shared optimistic boolean.

See
[`runtime-state-ownership.md`](architecture/runtime-state-ownership.md),
[`status-data-contracts.md`](architecture/status-data-contracts.md), and
[`traffic-data-contracts.md`](architecture/traffic-data-contracts.md).

### Desktop Startup and Settings

- Desktop bridge protocol version 28 retains separate login registration,
  login-window behavior, and application-launch behavior and adds the shared
  Rust-authoritative updater projection and operation commands.
- Application launch behavior is one of `off`, `core`, or `proxy`. Automatic
  startup reuses the Profile activation and capture coordinators rather than
  creating a desktop-only lifecycle.
- Browser Client binding starts at loopback port 6474 and selects the first
  available subsequent port without a probe-and-rebind race.
- The main window can reveal a lightweight startup placeholder before React and
  authenticated bridge initialization finish.
- A synchronous self-hosted appearance bootstrap initializes that placeholder
  under the strict Desktop and Browser Client CSP. Missing, malformed, stale,
  or unavailable browser hints fail safely before the Rust-authoritative
  Settings snapshot converges through an idempotent React projection.

See [`settings-contracts.md`](architecture/settings-contracts.md) and
[`desktop-bootstrap.md`](architecture/desktop-bootstrap.md).

### Development TUN

- The source-development helper path has real disposable-macOS acceptance
  evidence for install, health, ownership, TUN activation, traffic, lifecycle
  recovery, and uninstall.
- Internal helper clients additionally use an installation-scoped P-256
  possession proof without replacing the existing UID, PID, private-socket,
  filesystem, freshness, single-owner, Core-identity, or observed-network-state
  checks. Deterministic mode-`0600` persistence, replay and expiry bounds,
  dual-proof rotation, explicit administrator reset, fail-closed cleanup, and
  complete key-state uninstall have disposable-macOS evidence.
- Ordinary product builds and current release profiles continue to report
  Virtual Interface as unavailable. The accepted development path does not make
  production TUN a shipped capability.

See [`macos-tun-helper.md`](architecture/macos-tun-helper.md) and
[`macos-tart-tun-acceptance.md`](quality/macos-tart-tun-acceptance.md).

### macOS Packaging and Updates

- `alpha-ad-hoc` builds a credential-free Apple Silicon System Proxy-only DMG.
- `signed-direct` has a credential-free policy, bundle-shape, identity, and
  Draft workflow foundation. Live Developer ID trust and notarization still
  require protected Apple credentials.
- The updater has a strict channel, SemVer, signature, artifact-identity,
  provenance, downgrade, bounded download, resume, private candidate staging,
  restart recovery, and cross-client Rust-authority contract. The shipped app
  remains honestly unconfigured until a production key and endpoint exist, and
  no install, replacement, rollback, or relaunch action exists.

See [`macos-packaging.md`](operations/macos-packaging.md) and
[`updater-contract.md`](architecture/updater-contract.md).

## Not Delivered

- A notarized, stapled, publicly released Developer ID build.
- Production-enabled automatic update discovery, installation, rollback,
  relaunch, or System Proxy recovery around replacement.
- A production-signed TUN helper and production Virtual Interface capability.
- Intel macOS support or production Android, iOS, Windows, or Linux releases.
- Evidence that the current `main` packaging workflow can execute under the
  repository's present hosted Actions account state.

## Review Concerns

### Hosted `main` Packaging Evidence

The latest reviewed push run,
[CI run 30214824233](https://github.com/Asuka109/mish/actions/runs/30214824233),
created the macOS and Android packaging jobs but both completed with zero
executed steps. Until the account-level Actions restriction is removed and a
clean run succeeds, local fixture and package verification remain the current
evidence.

## Internal-Testing Compatibility Boundary

Mish is still under rapid internal development. Settings and behavior
compatibility across internal builds is not currently a product requirement.
Unsupported or structurally incompatible settings records may recover to safe
defaults instead of preserving individual preferences. This is an intentional
stage boundary rather than an open migration defect.

Before a compatibility commitment or public release, the supported upgrade
window and migration policy must be defined explicitly. See
[`settings-contracts.md`](architecture/settings-contracts.md).
