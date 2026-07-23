# Development commands

Run project commands from the repository root unless a command says otherwise.
The root `package.json` is the authoritative command registry. Root commands
use `<scope>:<action>[:<variant>]` when they target one product area and
`<action>:<variant>` for cross-repository workflows.

## Daily commands

| Command             | Purpose                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm demo`         | Start the explicit browser demo on the first port from 4173.                                                  |
| `pnpm desktop:demo` | Start the backend-free demo in a native Tauri window.                                                         |
| `pnpm dev`          | Start the ordinary unauthenticated Web development entry.                                                     |
| `pnpm desktop:dev`  | Start operational Tauri, print a one-time authorized Browser Client URL, and use an auto-selected Web origin. |
| `pnpm test:watch`   | Run Web unit tests in watch mode.                                                                             |
| `pnpm test:unit`    | Run all TypeScript unit tests once.                                                                           |
| `pnpm check`        | Run the fast pull-request-equivalent gate.                                                                    |
| `pnpm check:all`    | Run the complete non-browser repository inspection.                                                           |
| `pnpm test:browser` | Run the responsive suite in a real Chromium browser.                                                          |

Arguments pass through to the underlying package command. For example:

```sh
pnpm web:dev -- --port 4173
pnpm demo -- --port 4173
pnpm web:test:run -- src/path/to/example.test.ts
```

## Scoped development and build commands

| Scope   | Commands                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Web     | `web:demo`, `web:dev`, `web:build`, `web:preview`, `web:test`, `web:test:run`                                                              |
| Desktop | `desktop:demo`, `desktop:dev`, `desktop:build`, `desktop:bundle:macos`, `desktop:bundle:alpha-ad-hoc:macos`, `desktop:bundle:verify:macos` |
| Android | `mobile:android:init`, `mobile:android:configure`, `mobile:android:prepare-tests`, `mobile:android:test`, `mobile:android:build`           |

`pnpm demo` starts the fixture-backed production Web composition used for model,
visual, and interaction validation without contacting a desktop backend.

Web servers and backend-free desktop demos from separate worktrees can run
concurrently because each process falls back to its own available port. An
operational desktop launcher coordinates that port but intentionally retains
one shared managed-runtime lease; stop the running operational desktop before
launching another worktree that can operate Mihomo or system capture.

## Tests

| Command          | Coverage                                                          |
| ---------------- | ----------------------------------------------------------------- |
| `test:watch`     | Web Vitest watch mode.                                            |
| `test:unit`      | Web, mock bridge, and RPC client unit tests, once.                |
| `test:workspace` | Every package that defines `test:run`, including native packages. |
| `test:rust`      | Complete Cargo workspace with one test thread.                    |
| `test:browser`   | Real-Chromium responsive coverage.                                |
| `test:macos:p0`  | Credential-free macOS P0 fixture journey.                         |

Install the repository-pinned Chromium once with
`pnpm test:browser:install`.

## Checks

| Command                | Coverage                                                                     |
| ---------------------- | ---------------------------------------------------------------------------- |
| `check`                | Alias for `check:pr`.                                                        |
| `check:pr`             | Bounded pull-request gate used by CI.                                        |
| `check:all`            | Complete non-browser validation used by main inspection.                     |
| `check:types`          | TypeScript type checks followed by Cargo workspace check.                    |
| `check:types:ts`       | TypeScript packages only.                                                    |
| `check:rust`           | Cargo workspace check.                                                       |
| `check:rust:format`    | Rust formatting.                                                             |
| `check:rust:clippy`    | Clippy with warnings denied.                                                 |
| `check:format`         | Repository formatting without writing changes.                               |
| `check:lint`           | TypeScript and JavaScript lint.                                              |
| `check:i18n`           | Generated localization contract.                                             |
| `check:android`        | Generated Android project contract.                                          |
| `check:tokens`         | Generated design-token contract.                                             |
| `check:design`         | `DESIGN.md` contract lint.                                                   |
| `check:docs`           | Local Markdown links and public-release contracts.                           |
| `check:public-release` | Public files, packaged notices, metadata, attribution, and claim boundaries. |
| `check:ci`             | CI workflow contract.                                                        |

`pnpm format` is the intentional write-mode counterpart to
`pnpm check:format`.

## Generation and preparation

| Command              | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `generate:i18n`      | Regenerate typed localization files.         |
| `generate:brand`     | Regenerate repository-owned brand assets.    |
| `prepare:mihomo`     | Download and verify the pinned desktop Core. |
| `mobile-core:build`  | Build the pinned Android Mobile Core.        |
| `mobile-core:verify` | Verify Mobile Core evidence and artifacts.   |

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
