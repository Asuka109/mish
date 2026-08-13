# Development commands

Run project commands from the repository root unless a command says otherwise.
The root `package.json` is the authoritative command registry. Root commands
use `<scope>:<action>[:<variant>]` when they target one product area and
`<action>:<variant>` for cross-repository workflows.

## Daily commands

| Command                     | Purpose                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm demo`                 | Start the explicit browser demo on the first port from 4173.                                                            |
| `pnpm desktop:demo`         | Start the backend-free demo in a native Tauri window.                                                                   |
| `pnpm dev`                  | Start the ordinary unauthenticated Web development entry.                                                               |
| `pnpm desktop:dev`          | Start operational Tauri headlessly, prepare development Core, and print Browser Client and desktop-window trigger URLs. |
| `pnpm desktop:dev:tart-tun` | Start the explicit disposable-Tart development TUN acceptance entry.                                                    |
| `pnpm test:watch`           | Run Web unit tests in watch mode.                                                                                       |
| `pnpm test:unit`            | Run all TypeScript unit tests once.                                                                                     |
| `pnpm check`                | Run the fast pull-request-equivalent gate.                                                                              |
| `pnpm check:all`            | Run the complete non-browser repository inspection.                                                                     |
| `pnpm test:browser`         | Run the responsive suite in a real Chromium browser.                                                                    |

Arguments pass through to the underlying package command. For example:

```sh
pnpm web:dev -- --port 4173
pnpm demo -- --port 4173
pnpm web:test:run -- src/path/to/example.test.ts
```

The tracked `apps/desktop/.env.development` sets `MISH_DEVTOOLS=1` for
`desktop:dev` and `desktop:demo`. The ordinary operational development command
starts the real Rust backend without creating, showing, or focusing a WebView
or Inspector. After readiness it prints these stable prefixes:

```text
Mish Browser Client URL: <authenticated loopback launch URL>
Mish Desktop Window Trigger URL: <development-only loopback trigger URL>
```

The Browser Client is the primary headless development surface. Its single
printed URL can authenticate multiple clean browser contexts until a hot restart
prints a replacement and invalidates the prior capability. Production status-bar
launch URLs remain short-lived and one-time. Open the second
URL to create or reveal the one native main window; closing it hides only the
window, and opening the same unexpired trigger again reveals it. Hot restart
prints new process-scoped links and remains hidden. The configured Inspector
opens only with an explicitly created development WebView. `desktop:demo`
retains its ordinary window and Inspector behavior.

Opening a browser is opt-in and does not change either printed URL:

```sh
pnpm desktop:dev -- --open
```

The launcher uses the operating system's standard URL opener. Failure is
non-fatal and leaves the backend, RPC service, and printed links available.

When `MISH_MIHOMO_BIN` is unset, the launcher prepares and verifies the
repository-pinned Core. An explicit value remains the local Core debugging
override and must identify an absolute regular mode-`0755` executable reporting
the required macOS arm64 version. A missing or invalid explicit override fails
early and never falls back to the repository pin. For example:

```sh
MISH_MIHOMO_BIN="/absolute/path/to/local/mihomo" pnpm desktop:dev
```

Disable the Inspector for one development process with:

```sh
MISH_DEVTOOLS=0 pnpm desktop:dev
```

The desktop launcher also recognizes `--devtools` as an application startup
flag and passes it beyond Tauri's runner boundary. It takes precedence over the
environment. Without the flag, `MISH_DEVTOOLS` accepts exactly `1` or `0`;
malformed values stop startup with the Inspector disabled. Missing input
defaults off. The `.env.development` file is loaded only by the two source
development commands; release builds and packaged launch never load it. No
value is persisted.

The Inspector can reveal local state, tokens, authenticated bridge payloads,
Profile-derived data, network activity, and other sensitive diagnostics.
Review and redact Inspector screenshots, exports, or copied values before
sharing them. This option does not enable a remote debugging port, add a
listener, affect the standalone Browser Client, or relax bridge, CSP, or RPC
authorization.

## Scoped development and build commands

| Scope   | Commands                                                                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web     | `web:demo`, `web:dev`, `web:build`, `web:preview`, `web:test`, `web:test:run`                                                                                                                   |
| Desktop | `desktop:demo`, `desktop:dev`, `desktop:build`, `desktop:build:macos`, `desktop:bundle:macos`, `desktop:bundle:macos:open`, `desktop:bundle:signed-direct:macos`, `desktop:bundle:verify:macos` |
| Android | `mobile:android:init`, `mobile:android:configure`, `mobile:android:prepare-tests`, `mobile:android:test`, `mobile:android:build`                                                                |

The checkout-free Developer-ID-free service archive uses
`macos:internal-tun-alpha:package` and
`macos:internal-tun-alpha:verify -- PACKAGE_ROOT`. These build-host commands
produce and inspect the explicit `internal-tun-alpha` profile. Its archive root
contains only `Mish.app`; the sealed native lifecycle payload lives inside the
application and is reached through Mish's Capture controls after drag-install.
The target Mac does not need pnpm, Node.js, Rust, Homebrew, or a network
download. The package remains TUN-disabled and is not an application release.

The development-only privileged Core host is opt-in and uses
`macos:core-host:build`, `macos:core-host:install`, `macos:core-host:status`,
`macos:core-host:health`, `macos:core-host:disable`, and
`macos:core-host:uninstall`. These commands are excluded from ordinary desktop
and release builds. Follow
[`macos-development-core-host.md`](macos-development-core-host.md) for the
administrator-operated acceptance procedure.

Ordinary source development may opt into Virtual Interface by starting
`desktop:dev`, opening the desktop-window trigger, opening Settings, choosing
**Install virtual interface**, and
approving the native administrator prompt. Restart the dev process once before
activation. `macos:tun:prepare:dev`, `macos:tun:install:dev`, and the shared
`macos:tun:uninstall` remain equivalent CLI preparation and recovery paths.
Startup never installs privileged state without the explicit Settings action.

Only inside a disposable Tart clone, use `macos:tun:prepare:tart`,
`macos:tun:install:tart`, `desktop:dev:tart-tun`, and
`macos:tun:uninstall:tart`. The launcher and service must both receive that
exact acceptance opt-in. It adds only Tart DNS fixtures, failure injection, and
the terminal-authorization transport; ordinary source development and every
packaged layout cannot select them. The acceptance harness is
`scripts/macos-tart-tun-rpc.ts`. It accepts only the repository-owned
`fictional-tart.yaml` profile and emits bounded, redacted state. After
`bootstrap`, use `activate-core` to establish the ordinary managed Core before
`enable` when testing the local-listener handoff. Finish with `disable` and
`stop-core`; neither command replaces the required Helper uninstall and
network-residue checks.

`pnpm demo` starts the fixture-backed production Web composition used for model,
visual, and interaction validation without contacting a desktop backend.

Web servers and backend-free desktop demos from separate worktrees can run
concurrently because each process falls back to its own available port. An
operational desktop launcher coordinates that port but intentionally retains
one shared managed-runtime lease; stop the running operational desktop before
launching another worktree that can operate Mihomo or system capture.

## Tests

| Command                              | Coverage                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `test:watch`                         | Web Vitest watch mode.                                                     |
| `test:unit`                          | Web, transport-only mock bridge, and RPC client unit tests, once.          |
| `test:workspace`                     | Every package that defines `test:run`, including native packages.          |
| `test:rust`                          | Complete Cargo workspace with one test thread.                             |
| `test:application:simulated-host`    | Rust-authoritative logical-time models, authenticated RPC, and React path. |
| `test:rust:internal-tun-maintenance` | Exact nine-scenario Internal TUN maintenance contract.                     |
| `test:browser`                       | Real-Chromium responsive and simulated-host application coverage.          |
| `test:macos:p0`                      | Credential-free macOS P0 fixture journey.                                  |
| `test:macos:internal-tun-alpha`      | Closed package manifest, layout, integrity, and leakage policy.            |
| `test:macos:release`                 | Credential-free Alpha release validation and staging decisions.            |

Install the repository-pinned Chromium once with
`pnpm test:browser:install`.

The simulated-host command is non-privileged application evidence. It does not
replace the macOS P0, Tart/Helper, signed-package, real-network, or manual UI
acceptance boundaries.

## Checks

| Command                        | Coverage                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `check`                        | Alias for `check:pr`.                                                                                      |
| `check:pr`                     | Bounded pull-request gate used by CI.                                                                      |
| `check:all`                    | Complete non-browser validation used by main inspection.                                                   |
| `check:types`                  | TypeScript type checks followed by Cargo workspace check.                                                  |
| `check:types:ts`               | TypeScript packages only.                                                                                  |
| `check:rust`                   | Cargo workspace check.                                                                                     |
| `check:rust:format`            | Rust formatting.                                                                                           |
| `check:rust:clippy`            | Full workspace/all-target Clippy used by main inspection, warnings denied.                                 |
| `check:rust:pr`                | Portable PR Clippy contract; host Tauri application crates stay in inspection.                             |
| `check:format`                 | Repository formatting without writing changes.                                                             |
| `check:lint`                   | High-signal TypeScript/JavaScript correctness, React, accessibility, import, Promise, test, and Node lint. |
| `check:i18n`                   | Generated localization contract.                                                                           |
| `check:android`                | Generated Android project contract.                                                                        |
| `check:tokens`                 | Generated design-token contract.                                                                           |
| `check:design`                 | `DESIGN.md` contract lint.                                                                                 |
| `check:docs`                   | Local Markdown links and public-release contracts.                                                         |
| `check:public-release`         | Public files, packaged notices, metadata, attribution, and claim boundaries.                               |
| `check:ci`                     | CI workflow contract.                                                                                      |
| `check:macos:release-workflow` | Manual Alpha Draft staging permissions and ordering contract.                                              |

`pnpm format` is the intentional write-mode counterpart to
`pnpm check:format`.

The root `.oxlintrc.json` is the single code-lint configuration used by local commands,
editors, and CI. Native correctness, suspicious, performance, React, Hooks, Refresh,
React Perf, accessibility, import, Promise, Vitest, and Node findings are advisory
warnings during the improvement rollout, so existing findings do not block delivery.
Pedantic, restriction, nursery, and formatting rules stay disabled; Oxfmt remains the
only formatting authority, and TypeScript remains the type-check authority. Generated
localization/contracts and negative lint fixtures are excluded by exact paths.
Type-aware Oxlint is deferred because it currently adds the separate `oxlint-tsgolint`
runtime and requires built monorepo declarations. ESLint, Prettier, Biome, and Stylelint
are neither installed nor accepted as alternate lint authorities; legacy ESLint disable
directives are not consumed by Oxlint.

## Generation and preparation

| Command                  | Purpose                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `generate:i18n`          | Regenerate typed localization files.                                           |
| `generate:brand`         | Regenerate repository-owned brand assets.                                      |
| `geodata:update`         | Download the latest full GeoData snapshot and record exact release provenance. |
| `geodata:verify-runtime` | Prove pinned Mihomo consumes the bundled files offline in both GeoData modes.  |
| `prepare:mihomo`         | Explicitly prepare and verify the Core used automatically by `desktop:dev`.    |
| `mobile-core:build`      | Build the pinned Android Mobile Core.                                          |
| `mobile-core:verify`     | Verify Mobile Core evidence and artifacts.                                     |
| `release:macos:fixture`  | Exercise deterministic release staging decisions without GitHub writes.        |

`pnpm geodata:update` downloads the four required release assets into a staging
directory, verifies their release sizes and SHA-256 digests, and replaces the
tracked `resources/geodata/snapshot` only after the complete snapshot passes.
Review and commit the resulting binary and manifest diff together. Release
packaging consumes only that pinned repository snapshot; it never resolves the
mutable upstream `latest` tag.

Desktop development builds seed the same repository snapshot into the private
Core home. This keeps local cold-launch behavior representative of the packaged
fallback instead of silently exercising Mihomo's network download path.
Run `pnpm prepare:mihomo && pnpm geodata:verify-runtime` after each update. The
runtime verifier ignores ambient Core overrides, forces all GeoData download
URLs to unreachable loopback, and requires real pinned-Mihomo validation to
succeed without any download attempt.

## Compatibility aliases

The following commands remain available for existing local workflows and old
branches, but new documentation and automation use the canonical names:

| Compatibility command | Canonical command             |
| --------------------- | ----------------------------- |
| `validate:pr`         | `check:pr`                    |
| `validate`            | `check:all`                   |
| `typecheck`           | `check:types`                 |
| `typecheck:ts`        | `check:types:ts`              |
| `test:run`            | `test:workspace`              |
| `test:ts`             | `test:unit`                   |
| `rust:check`          | `check:rust`                  |
| `rust:format:check`   | `check:rust:format`           |
| `rust:clippy`         | `check:rust:clippy`           |
| `rust:test`           | `test:rust`                   |
| `format:check`        | `check:format`                |
| `lint`                | `check:lint`                  |
| `i18n:generate`       | `generate:i18n`               |
| `i18n:check`          | `check:i18n`                  |
| `brand:generate`      | `generate:brand`              |
| `mihomo:prepare`      | `prepare:mihomo`              |
| `android:check`       | `check:android`               |
| `tokens:check`        | `check:tokens`                |
| `design:lint`         | `check:design`                |
| `docs:links`          | `check:docs`                  |
| `ci:check`            | `check:ci`                    |
| `macos:bundle:verify` | `desktop:bundle:verify:macos` |

The unscoped `dev`, `build`, `preview`, and `test` commands remain short Web
aliases. Prefer the `web:*` form in automation where the target should be
explicit.
