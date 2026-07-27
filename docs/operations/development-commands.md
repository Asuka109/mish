# Development commands

Run project commands from the repository root unless a command says otherwise.
The root `package.json` is the authoritative command registry. Root commands
use `<scope>:<action>[:<variant>]` when they target one product area and
`<action>:<variant>` for cross-repository workflows.

## Daily commands

| Command                     | Purpose                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm demo`                 | Start the explicit browser demo on the first port from 4173.                                                  |
| `pnpm desktop:demo`         | Start the backend-free demo in a native Tauri window.                                                         |
| `pnpm dev`                  | Start the ordinary unauthenticated Web development entry.                                                     |
| `pnpm desktop:dev`          | Start operational Tauri, print a one-time authorized Browser Client URL, and use an auto-selected Web origin. |
| `pnpm desktop:dev:tart-tun` | Start the explicit disposable-Tart development TUN acceptance entry.                                          |
| `pnpm test:watch`           | Run Web unit tests in watch mode.                                                                             |
| `pnpm test:unit`            | Run all TypeScript unit tests once.                                                                           |
| `pnpm check`                | Run the fast pull-request-equivalent gate.                                                                    |
| `pnpm check:all`            | Run the complete non-browser repository inspection.                                                           |
| `pnpm test:browser`         | Run the responsive suite in a real Chromium browser.                                                          |

Arguments pass through to the underlying package command. For example:

```sh
pnpm web:dev -- --port 4173
pnpm demo -- --port 4173
pnpm web:test:run -- src/path/to/example.test.ts
```

The tracked `apps/desktop/.env.development` sets `MISH_DEVTOOLS=1` for
`desktop:dev` and `desktop:demo`. The normal development command therefore
opens the local WebKit Inspector as a separate window for only the current Mish
desktop process:

```sh
pnpm desktop:dev
```

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

| Scope   | Commands                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web     | `web:demo`, `web:dev`, `web:build`, `web:preview`, `web:test`, `web:test:run`                                                                                                                     |
| Desktop | `desktop:demo`, `desktop:dev`, `desktop:build`, `desktop:build:macos`, `desktop:bundle:macos`, `desktop:bundle:macos:styled`, `desktop:bundle:signed-direct:macos`, `desktop:bundle:verify:macos` |
| Android | `mobile:android:init`, `mobile:android:configure`, `mobile:android:prepare-tests`, `mobile:android:test`, `mobile:android:build`                                                                  |

The development-only privileged Core host is opt-in and uses
`macos:core-host:build`, `macos:core-host:install`, `macos:core-host:status`,
`macos:core-host:health`, `macos:core-host:disable`, and
`macos:core-host:uninstall`. These commands are excluded from ordinary desktop
and release builds. Follow
[`macos-development-core-host.md`](macos-development-core-host.md) for the
administrator-operated acceptance procedure.

The complete development TUN path is narrower still. Only inside a disposable
Tart clone, use `macos:tun:prepare:tart`, `macos:tun:install:tart`,
`desktop:dev:tart-tun`, and `macos:tun:uninstall:tart`. The launcher and service
must both receive that exact opt-in; ordinary source development and every
packaged layout stay unavailable. The acceptance harness is
`scripts/macos-tart-tun-rpc.ts`. It accepts only the repository-owned
`fictional-tart.yaml` profile and emits bounded, redacted state.

`pnpm demo` starts the fixture-backed production Web composition used for model,
visual, and interaction validation without contacting a desktop backend.

Web servers and backend-free desktop demos from separate worktrees can run
concurrently because each process falls back to its own available port. An
operational desktop launcher coordinates that port but intentionally retains
one shared managed-runtime lease; stop the running operational desktop before
launching another worktree that can operate Mihomo or system capture.

## Tests

| Command              | Coverage                                                          |
| -------------------- | ----------------------------------------------------------------- |
| `test:watch`         | Web Vitest watch mode.                                            |
| `test:unit`          | Web, mock bridge, and RPC client unit tests, once.                |
| `test:workspace`     | Every package that defines `test:run`, including native packages. |
| `test:rust`          | Complete Cargo workspace with one test thread.                    |
| `test:browser`       | Real-Chromium responsive coverage.                                |
| `test:macos:p0`      | Credential-free macOS P0 fixture journey.                         |
| `test:macos:release` | Credential-free Alpha release validation and staging decisions.   |

Install the repository-pinned Chromium once with
`pnpm test:browser:install`.

## Checks

| Command                        | Coverage                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `check`                        | Alias for `check:pr`.                                                        |
| `check:pr`                     | Bounded pull-request gate used by CI.                                        |
| `check:all`                    | Complete non-browser validation used by main inspection.                     |
| `check:types`                  | TypeScript type checks followed by Cargo workspace check.                    |
| `check:types:ts`               | TypeScript packages only.                                                    |
| `check:rust`                   | Cargo workspace check.                                                       |
| `check:rust:format`            | Rust formatting.                                                             |
| `check:rust:clippy`            | Clippy with warnings denied.                                                 |
| `check:format`                 | Repository formatting without writing changes.                               |
| `check:lint`                   | TypeScript and JavaScript lint.                                              |
| `check:i18n`                   | Generated localization contract.                                             |
| `check:android`                | Generated Android project contract.                                          |
| `check:tokens`                 | Generated design-token contract.                                             |
| `check:design`                 | `DESIGN.md` contract lint.                                                   |
| `check:docs`                   | Local Markdown links and public-release contracts.                           |
| `check:public-release`         | Public files, packaged notices, metadata, attribution, and claim boundaries. |
| `check:ci`                     | CI workflow contract.                                                        |
| `check:macos:release-workflow` | Manual Alpha Draft staging permissions and ordering contract.                |

`pnpm format` is the intentional write-mode counterpart to
`pnpm check:format`.

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
