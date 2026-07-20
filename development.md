# Mish Development Workflow

This document is the working agreement for maintainers and coding agents. It
assumes the workstation has completed [`bootstrap.md`](bootstrap.md).

Mish is in rapid preview development. Small, independently reviewable pull
requests are preferred, and locally validated preview PRs may be merged without
waiting for human review or a long CI cycle. This speed does not relax the
truthfulness, privacy, rollback, or platform-ownership boundaries documented in
[`PRODUCT.md`](PRODUCT.md), [`DESIGN.md`](DESIGN.md), and
[`docs/README.md`](docs/README.md).

## Start every session with evidence

```sh
git status --short
git branch --show-current
git fetch origin main
git log --oneline --decorate -5 origin/main
gh pr list --state open --limit 20
```

Read the smallest authoritative set for the task:

1. [`PRODUCT.md`](PRODUCT.md) for product behavior and claim boundaries;
2. [`DESIGN.md`](DESIGN.md) for UI and native-material rules;
3. [`docs/README.md`](docs/README.md) to find the relevant architecture,
   operation, and quality contract;
4. [`.claude/plans/development-plan.md`](.claude/plans/development-plan.md) for
   sequencing only, never as a replacement for the contracts above;
5. the implementation and tests that currently enforce the behavior.

Do not continue on top of unexplained changes. Existing dirty files may belong
to another human or agent session.

## Branches, worktrees, and parallel agents

Use one branch and preferably one Git worktree per independent task. Branches
should use a concise `codex/<topic>` name. Never force-push or rewrite another
session's branch.

Parallel work is safe when ownership does not overlap. Good concurrent lanes are:

| Lane                        | Typical ownership                                                  |
| --------------------------- | ------------------------------------------------------------------ |
| Desktop runtime             | `crates/desktop-bridge`, `crates/runtime`, `crates/platform-macos` |
| Web product UI              | `apps/web`, `packages/ui`, `packages/design-tokens`                |
| Android platform            | `apps/mobile/src-tauri/plugins`, generated Android project         |
| Mobile Core                 | `mobile-core`, Core build and verification scripts                 |
| Documentation or acceptance | a bounded document or read-only installed-app run                  |

High-conflict files require one owner at a time:

- root `package.json`, `pnpm-lock.yaml`, and `Cargo.lock`;
- `packages/contracts/src/index.ts`;
- generated i18n types;
- `apps/mobile/src-tauri/Cargo.toml` and generated Gradle settings;
- `.github/workflows/ci.yml`;
- shared architecture and validation documents.

Before assigning parallel work, state the exact file boundary, expected tests,
base commit, and whether the task may publish a PR. Re-fetch `origin/main` and
run a merge-tree or ordinary merge preflight before publication. If another PR
merged the same change, compare Git trees before deciding whether any repair is
needed; do not duplicate or revert blindly.

## Remote development machine versus handoff workstation

The current remote machine is best used for work that is deterministic and does
not require direct hardware interaction:

- architecture and implementation review;
- Rust, TypeScript, Kotlin, C ABI, and fixture unit tests;
- Web and responsive-browser work;
- static Android project checks;
- reproducible Core and package-evidence work when disk permits;
- CI, documentation, task decomposition, and PR preparation;
- macOS fixture journeys that do not change host network state.

Reserve the higher-capacity personal Apple Silicon Mac for:

- full Android and iOS toolchains, emulators, and Xcode;
- physical Android permission, TUN, TCP, UDP, DNS, background, battery, and
  network-switch testing;
- iOS shell, Packet Tunnel extension, XCFramework, signing, and simulator work;
- installed macOS app acceptance, native Sidebar material, System Proxy
  mutation and exact restoration;
- long-running, multi-ABI, or clean-room package builds;
- profiling with Instruments, Android Studio, and platform logs.

Do not let the remote machine become the only source of generated artifacts.
Git history, source manifests, checksums, documentation, and CI must be
sufficient to reproduce them on the handoff workstation.

## Recommended pre-handoff work plan

Complete as much hardware-independent work as possible before moving:

1. Finish and merge the bounded Android Mobile Core packaging and identity-probe
   slice, including cross-directory reproducibility evidence.
2. Keep the production `VpnService` fixture honest until configuration loading,
   TUN ownership, socket protection, and stop cleanup are implemented together.
3. Close deterministic desktop correctness issues, especially rollback,
   persistence, and recovery-journal gaps.
4. Keep the fast PR gate green and main-branch package workflows reproducible.
5. Convert all remaining hardware assumptions into explicit acceptance steps,
   expected observations, and safe cleanup instructions.
6. Record final branch, PR, artifact, checksum, disk, and known-blocker state in
   the handoff message.

After cloning on the personal Mac, the recommended order is:

1. complete `bootstrap.md` and run `pnpm check:pr`;
2. build and manually accept the current macOS prototype;
3. build the checksum-matched ARM64 Android package and install it on the target
   device;
4. replace the Android fixture backend with one narrow real-VPN vertical slice;
5. validate permission denial, start, TCP, UDP, DNS, background survival, and
   explicit stop before broadening UI work;
6. begin iOS compile-only scaffolding after the Android ABI and lifecycle shape
   is stable.

## Daily development loops

### Shared Web and contracts

```sh
pnpm dev
pnpm check:types:ts
pnpm test:unit
pnpm check:lint
```

After editing the English translation base or locale keys:

```sh
pnpm generate:i18n
pnpm check:i18n
```

The browser client is a visibly labelled fixture. It must not simulate desktop
or mobile native success.

### Rust runtime and desktop bridge

```sh
pnpm check:rust:format
pnpm check:rust
pnpm test:rust
pnpm check:rust:clippy
```

Use a focused package or integration test while iterating, then run the broader
gate before publication. The complete credential-free macOS prototype journey
is:

```sh
pnpm test:macos:p0
```

Real-Core tests require an explicitly prepared, checksum-verified binary and do
not run during ordinary startup:

```sh
pnpm prepare:mihomo
MIHOMO_BIN="$PWD/.scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29" \
  cargo test -p mish-bridge --test real_core_activation -- --nocapture
```

### Desktop application

```sh
export MISH_MIHOMO_BIN="$PWD/.scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29"
pnpm desktop:dev
pnpm desktop:build
pnpm desktop:bundle:macos
```

System Proxy is an operating-system mutation. Capture the current state before
manual acceptance, change it only in an authorized test, and confirm exact
restoration after Stop, Quit, failure, and forced process termination. TUN,
Developer ID signing, and notarization remain separate gates.

### Android fixture and native plugin

```sh
pnpm check:android
pnpm mobile:android:test
pnpm mobile:android:build
```

Do not hand-edit ignored schemas or autogenerated permissions. The committed
generated Android project contains intentional source inputs; inspect changes
after any Tauri regeneration.

### Mobile Core

```sh
pnpm mobile-core:contract
pnpm mobile-core:build
pnpm mobile-core:verify
pnpm mobile-core:stage:android
```

The canonical contract is
[`mobile-core/abi/mish_mobile_core.h`](mobile-core/abi/mish_mobile_core.h).
Core builds must remain source-pinned, dual-output reproducible, bounded, and
free of absolute local source paths. Never accept an unverified prebuilt native
library and never commit generated `.so` files.

## Validation before a PR

Run the smallest relevant tests during implementation. Before publishing a
normal preview PR, run:

```sh
pnpm check:pr
git diff --check
git status --short
```

Run additional gates in proportion to the affected risk:

| Change                    | Additional validation                                              |
| ------------------------- | ------------------------------------------------------------------ |
| Web layout or navigation  | `pnpm test:browser`                                                |
| Rust runtime behavior     | focused tests, then `pnpm test:rust` and Clippy                    |
| macOS bundle or resources | `pnpm desktop:bundle:macos`                                        |
| Android Kotlin or JNI     | `pnpm mobile:android:test`, plugin assemble, debug APK build       |
| Mobile Core               | contract, wrapper tests, reproducible build, evidence verification |
| Documentation             | `pnpm check:docs`                                                  |
| CI workflow               | `pnpm check:ci`                                                    |

Pull requests run only the fast gate on the dedicated macOS runner and upload no package. Pushes to
`main` build 14-day macOS and Android test artifacts. Daily and manual
inspections run the complete validation suite. A manual `packages` workflow
dispatch recovers package builds if an automated merge does not trigger a push
workflow.

## Preview PR policy

- Keep each PR independently understandable and reversible.
- Stage only intentional files; never use unrelated dirty work.
- Use conventional commit and PR titles.
- Include summary, exact claim boundary, and commands actually run.
- Ready preview PRs may be squash-merged quickly after local validation and a
  clean mergeability check; human review and CI completion are not mandatory at
  this stage unless the change is risky or protected by repository settings.
- Never force-push.
- After merge, verify `main`, note the squash commit, and inspect package workflow
  status without assuming an artifact exists.

## Generated files and cleanup

Disposable local content includes `node_modules/`, `target/`, `.scratch/`,
Gradle build directories, browser attachments, and generated native binaries.
Use `trash` for cleanup. Never delete tracked generated project inputs merely
because they live under `gen/`.

The retained [`sketch/`](sketch/) is an interaction reference, not the
production application. Do not use its mock data or behavior as runtime proof.

Before large Android, Rust, or Xcode builds:

```sh
df -h .
du -sh target .scratch apps/mobile/src-tauri/gen/android/.gradle 2>/dev/null || true
```

## Privacy and safety invariants

- Real subscription URLs and configuration content must not appear in source,
  task prompts, logs, screenshots, CI, issues, PR bodies, or documentation.
- Never log bridge tokens, native paths containing private data, node labels,
  credentials, or raw Controller payloads.
- No test may silently enable System Proxy, TUN, a listener, telemetry, or a
  remote download path.
- Every native capability reports unavailable until the platform has confirmed
  it.
- Failed activation preserves the prior healthy runtime or reaches an explicit
  safe stopped state.
- Desktop, Android, and iOS each retain their documented platform authority;
  the WebView never owns VPN lifetime or a TUN descriptor.

## Handoff checklist

Before moving work to another computer or participant, record:

1. repository URL, base branch, branch name, HEAD SHA, and PR URL/state;
2. whether the worktree is clean and every intentional uncommitted path;
3. the exact tests run and any unexecuted hardware gates;
4. artifact names, source SHA, ABI, signing mode, checksums, and retention;
5. toolchain versions and meaningful disk usage;
6. known defects, recovery state, and next smallest vertical slice;
7. whether System Proxy, VPN, helper, launch-at-login, or background processes
   were changed, plus proof that they were restored;
8. private inputs that must be re-entered manually rather than transferred;
9. any concurrent branch or PR that may overlap the work;
10. the recommended reading order and first verification command.

Do not transfer generated build caches as project truth. A successful handoff
starts from a fresh clone, reproduces the documented gates, and makes all
hardware-dependent unknowns visible.
