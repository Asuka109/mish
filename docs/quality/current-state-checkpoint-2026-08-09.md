# Repository Checkpoint — 2026-08-09

Captured against `main` at `d925f0abd09c1f153cc54f2e2bcea054b6477b1e`.

This is immutable historical evidence, not current repository truth. It records
what was reviewed at the named commit, including then-current capability and CI
observations. Later implementation or CI runs neither update this checkpoint nor
retroactively satisfy evidence that was unavailable at capture time. Use
[`../current-state.md`](../current-state.md) for the maintained entry path and
the linked domain documents for durable contracts.

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

- `pnpm check:pr` passed on the reviewed commit: 549 Web tests, 10 RPC client
  tests, 5 mock bridge tests, 148 script tests, 38 SimulatedHost Rust scenarios,
  8 Chromium scenarios, and the repository lint, type, format, localization,
  token, documentation, public-release, Core-lifecycle-authority, and
  runtime-state ownership checks.
- The latest `main` push run,
  [CI run 31294286763](https://github.com/Asuka109/mish/actions/runs/31294286763),
  succeeded. Its macOS ARM64 and Android packaging jobs executed 15 and 20
  steps respectively; the later scheduled inspection run 31295084614 also
  succeeded.
- The reviewed-main Internal TUN Alpha staging run
  [31296492082](https://github.com/Asuka109/mish/actions/runs/31296492082)
  froze source and tooling at this exact SHA, built the `.7` package, verified
  the candidate independently, created final immutable artifact ID
  `9033283912`, and reverified that exact artifact read-only on a fresh macOS
  runner.
- A separate local Apple Silicon reproduction generated two byte-identical
  candidate sets across an intervening package verification. Both independent
  read-only verifications matched, and the final local confirmation passed.
- The live trust-settings audit remains `disabled-fail-closed` for production
  signing and publication because required branch review, protected
  Environments, and workflow-bound OIDC controls remain unavailable. The
  credential-free Internal TUN lane does not cross that boundary.

## Implemented

### Runtime and Cross-Surface State

- Rust owns the durable and process-global state required across the desktop
  WebView, Browser Client, native status menu, and reconnecting clients.
  Application snapshots have monotonic ordering, runtime-scoped commands reject
  replaced-runtime completion, capture operations have explicit identities, and
  Profile activation has a typed data-bearing lifecycle. Capture's aggregate
  lifecycle is a domain-owned outer state machine whose `Applied` terminal is
  gated by authoritative Core/platform observation. Its existing System Proxy
  journal and TUN adapter remain intact, while protocol version 36 retains the
  version-34 authoritative `Finalizing` cleanup window across surfaces and
  adds checked metadata plus mandatory per-connection compatibility.
- Recent Traffic authority is retained on the Rust side. Web pause/resume keeps
  a presentation snapshot while continuing to receive the latest authoritative
  state.
- Web command feedback is keyed by operation and scope instead of relying on
  one shared optimistic boolean. Capture keeps Pending and Finalizing inside
  the initiating controls without shifting the page; terminal failures reuse
  the canonical notification and routine success adds no persistent feedback.
- The cross-platform audit classifies Status/capture, Profile/configuration,
  Routes, Traffic, Events/Diagnostics, Settings, notifications, updater,
  lifecycle, desktop transport, Android Tauri/Kotlin/JNI, and Mobile Core state
  by reset scope and canonical cleanup owner. Desktop RPC and mobile Tauri are
  projections of one Shared Rust domain boundary; mobile must not embed the
  desktop loopback bridge.

See
[`cross-platform-product-authority.md`](../architecture/cross-platform-product-authority.md),
[`runtime-state-ownership.md`](../architecture/runtime-state-ownership.md),
[`status-data-contracts.md`](../architecture/status-data-contracts.md), and
[`traffic-data-contracts.md`](../architecture/traffic-data-contracts.md).

### Android VPN Vertical Slice

- Shared Rust owns the Android VPN lifecycle authority, command operation and
  product session identity, revision/sequence, cancellation, stale completion,
  terminal outcome, and recovery policy.
- Kotlin owns the real foreground `VpnService`, dual-stack TUN/default routes,
  fixed DNS policy, validated underlying-network observation, socket
  protection, embedded Core effects, and bounded fact publication. Running is
  gated on every same-session platform fact plus one fixed public request.
- The closed JNI/Mobile Core path consumes only the exact bounded configuration
  authority, duplicates the TUN descriptor inside the Core wrapper, and exposes
  no path, Controller endpoint, or arbitrary native command.
- Local ARM64 emulator/Appium evidence covers Running, background/foreground,
  rotation, cancellation, network loss/recovery, process recovery, and complete
  stop cleanup. Physical ARM64 and x86_64 emulator runtime acceptance remain
  open gates and are not inferred from cross-compilation.

See [`android-vpn-service.md`](../operations/android-vpn-service.md) and
[`mobile-validation.md`](mobile-validation.md).

### Mobile Product Navigation

- The installed React `MobileShell` and React Router are the sole owners of
  persistent mobile product chrome, top-level destinations, child routes,
  history/Back, overlays/sheets, scroll state, and DOM focus.
- The production-disabled Shared Rust shell-entry contract and Android/Apple
  persistent-shell research prototypes were retired after hands-on review of
  #373 exposed split navigation ownership. #343/#370/#372 remain superseded
  historical evidence; #374 is not planned.
- Native code continues to own genuine platform effects behind typed,
  permission-scoped adapters, including Android VPN consent, foreground service,
  TUN/socket protection, embedded Core, and platform lifecycle. No arbitrary
  Web-to-Native script, message, URL-command, UI, or capability channel is
  accepted.

See
[`mobile-runtime-integration.md`](../architecture/mobile-runtime-integration.md),
[`mobile-navigation-and-layout.md`](../design/mobile-navigation-and-layout.md), and
the durable
[`native-persistent-mobile-shell.md`](../../.out-of-scope/native-persistent-mobile-shell.md)
decision.

### Desktop Startup and Settings

- Desktop bridge protocol version 36 retains separate login registration,
  login-window behavior, application-launch behavior, and the shared updater
  projection, plus the version 33 Rust-authoritative policy-group selection
  availability. Version 34 added the typed Capture failure and `finalizing`
  projection so Status, Settings, native controls, and reconnecting clients
  stay blocked through cancellation, rollback, Core/process cleanup, and
  network restoration. Version 35 adds a process-scoped Rust authority and
  complete-snapshot order to Settings while retaining the separate durable
  preference revision. Accepted Network/DNS and TUN Helper observations now
  publish to Desktop, Browser, and native subscribers, and a replacement
  process baseline may safely start at a lower preference revision.
- Protocol 36 generates Rust and TypeScript metadata from one checked source,
  verifies exact public method parity against live server dispatch, and makes
  `compatible`, `client-too-old`, and `backend-too-old` explicit before any
  product RPC. All product clients share that fail-closed transport gate while
  retaining domain-specific command capabilities and snapshot ordering.
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

See [`settings-contracts.md`](../architecture/settings-contracts.md) and
[`desktop-bootstrap.md`](../architecture/desktop-bootstrap.md).

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

See [`macos-tun-helper.md`](../architecture/macos-tun-helper.md) and
[`macos-tart-tun-acceptance.md`](macos-tart-tun-acceptance.md).

### macOS Packaging and Updates

- `alpha-ad-hoc` builds a credential-free Apple Silicon System Proxy-only DMG.
- `internal-tun-alpha` builds the accepted Apple Silicon, macOS 13+,
  Developer-ID-free Helper/Core service package for explicitly trusted internal
  Macs. Its Finder DMG exposes only `Mish.app` and `Applications`; the sealed
  Helper/Core/controller/manifest payload remains inside `Mish.app` after
  drag-install. It installs only through visible administrator authorization,
  remains healthy-disabled, exposes no network-mutation command, and retains
  the file-backed same-user-key limitation.
- The manual reviewed-main workflow has a separate credential-free Internal TUN
  staging lane. It binds the exact frozen source/workflow/tooling revision,
  package inputs, lockfiles, SBOM, provenance, DMG digest, and run identity,
  independently verifies the downloaded DMG read-only, and uploads a
  non-overwriting private 14-day artifact only after complete evidence exists.
  This lane is neither Developer ID signing nor public release publication.
- `signed-direct` has a credential-free policy, bundle-shape, identity, and
  deterministic fixture foundation. The repository-wide trust policy now pins
  workflow dependencies, keeps untrusted PR code on GitHub-hosted runners,
  freezes repository/workflow/tooling/source identity, binds credential-free
  candidates to immutable artifact IDs and complete manifests, and rejects
  adversarial refs, actors, reusable callers, runners, and substitutions.
- Protected signing, notarization, attestation, publication, and deployment are
  fail-closed and absent from executable workflows. The repository's current
  settings do not enforce protected branches or reviewer-protected
  Environments, so the checked-in activation flag remains false.
- The updater has a strict channel, SemVer, signature, artifact-identity,
  provenance, downgrade, bounded download, resume, private candidate staging,
  restart recovery, and cross-client Rust-authority contract. The shipped app
  remains honestly unconfigured until a production key and endpoint exist, and
  no install, replacement, rollback, or relaunch action exists.

See [`macos-packaging.md`](../operations/macos-packaging.md) and
[`updater-contract.md`](../architecture/updater-contract.md).

## Not Delivered

- Production mobile Profile import/commit, Routes, Traffic commands, Events,
  Diagnostics, or semantic notification projection. The first Android VPN
  slice activates only the exact bounded configuration authority already
  validated and loaded by the native Core contract.
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

## Internal-Testing Compatibility Boundary

Mish is still under rapid internal development. Settings and behavior
compatibility across internal builds is not currently a product requirement.
Unsupported or structurally incompatible settings records may recover to safe
defaults instead of preserving individual preferences. This is an intentional
stage boundary rather than an open migration defect.

Before a compatibility commitment or public release, the supported upgrade
window and migration policy must be defined explicitly. See
[`settings-contracts.md`](../architecture/settings-contracts.md).
