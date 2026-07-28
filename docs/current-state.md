# Current Repository State

Refreshed 2026-07-28 against `main` at
`fed0edc1be1ac1dddc0b07fef692221b20dc12ca`.

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
  Profile activation has a typed data-bearing lifecycle. Capture's aggregate
  lifecycle is a domain-owned outer state machine whose `Applied` terminal is
  gated by authoritative Core/platform observation; its existing System Proxy
  journal, TUN adapter, public protocol, and cross-surface projections are
  unchanged.
- Recent Traffic authority is retained on the Rust side. Web pause/resume keeps
  a presentation snapshot while continuing to receive the latest authoritative
  state.
- Web command feedback is keyed by operation and scope instead of relying on
  one shared optimistic boolean.
- The cross-platform audit classifies Status/capture, Profile/configuration,
  Routes, Traffic, Events/Diagnostics, Settings, notifications, updater,
  lifecycle, desktop transport, Android Tauri/Kotlin/JNI, and Mobile Core state
  by reset scope and canonical cleanup owner. Desktop RPC and mobile Tauri are
  projections of one Shared Rust domain boundary; mobile must not embed the
  desktop loopback bridge.

See
[`cross-platform-product-authority.md`](architecture/cross-platform-product-authority.md),
[`runtime-state-ownership.md`](architecture/runtime-state-ownership.md),
[`status-data-contracts.md`](architecture/status-data-contracts.md), and
[`traffic-data-contracts.md`](architecture/traffic-data-contracts.md).

### Desktop Startup and Settings

- Desktop bridge protocol version 29 retains separate login registration,
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
- `internal-tun-alpha` builds the accepted Apple Silicon, macOS 13+,
  Developer-ID-free Helper/Core service package for explicitly trusted internal
  Macs. It installs only through visible administrator authorization, remains
  healthy-disabled, exposes no network-mutation command, and retains the
  file-backed same-user-key limitation.
- The manual reviewed-main workflow has a separate credential-free Internal TUN
  staging lane. It binds the exact frozen source/workflow/tooling revision,
  package inputs, lockfiles, SBOM, provenance, DMG digest, and run identity,
  independently verifies the downloaded DMG read-only, and uploads a
  non-overwriting private 14-day artifact only after complete evidence exists.
  This lane is neither Developer ID signing nor public release publication.
- `signed-direct` has a credential-free policy, bundle-shape, identity, and
  deterministic fixture foundation. The repository-wide trust policy now pins
  workflow dependencies, moves untrusted PR code off the self-hosted runner,
  freezes repository/workflow/tooling/source identity, binds credential-free
  candidates to immutable artifact IDs and complete manifests, and rejects
  adversarial refs, actors, reusable callers, runners, and substitutions.
- Protected signing, notarization, attestation, publication, and deployment are
  fail-closed and absent from executable workflows. The private repository's
  current plan cannot enforce protected branches or reviewer-protected
  Environments, so the checked-in activation flag remains false.
- The updater has a strict channel, SemVer, signature, artifact-identity,
  provenance, downgrade, bounded download, resume, private candidate staging,
  restart recovery, and cross-client Rust-authority contract. The shipped app
  remains honestly unconfigured until a production key and endpoint exist, and
  no install, replacement, rollback, or relaunch action exists.

See [`macos-packaging.md`](operations/macos-packaging.md) and
[`updater-contract.md`](architecture/updater-contract.md).

## Not Delivered

- Shared Rust authority for the Android VPN product lifecycle. The current
  Phase 0 prototype intentionally owns fixture phase/sequence/persistence in
  Kotlin and projects fixture Status/Profile/Traffic/Events/Settings clients.
- Production mobile Profile activation, configuration loading, TUN/socket
  protection, Routes, Traffic commands, Events, Diagnostics, or semantic
  notification projection. The staged Mobile Core and JNI path expose only
  bounded ABI/version evidence.
- Production Android-specific page composition beyond the current mobile shell
  and fixture banner. Shared route components are not evidence for a universal
  desktop/mobile page.
- A notarized, stapled, publicly released Developer ID build.
- A runner-executed protected release gate, enforced CODEOWNERS review,
  reviewer-protected signing/publication Environments, custom workflow-bound
  OIDC subject, or server-side full-SHA action policy.
- Production-enabled automatic update discovery, installation, rollback,
  relaunch, or System Proxy recovery around replacement.
- A production-signed TUN helper and production Virtual Interface capability.
- Intel macOS support or production Android, iOS, Windows, or Linux releases.
- Evidence that the current `main` packaging workflow can execute under the
  repository's present hosted Actions account state.
- A successful hosted immutable Internal TUN Alpha stage while the repository
  billing/spending-limit or macOS-runner allocation condition remains
  unresolved. Local deterministic reproduction is not substituted for that
  external artifact state.

## Review Concerns

### Hosted `main` Packaging Evidence

The latest reviewed push run,
[CI run 30275672515](https://github.com/Asuka109/mish/actions/runs/30275672515),
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
