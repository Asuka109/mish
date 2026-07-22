# Mish Development Workflow

This is the working agreement for maintainers and coding agents. Complete
[`bootstrap.md`](bootstrap.md) once; use the
[command registry](docs/operations/development-commands.md) for command details.

## Start with evidence

```sh
git status --short
git branch --show-current
git log --oneline --decorate -5
```

Preserve unexplained changes. Before editing, read only the authorities needed
for the task:

1. [`PRODUCT.md`](PRODUCT.md) for behavior and claim boundaries;
2. [`DESIGN.md`](DESIGN.md) for UI work;
3. [`docs/README.md`](docs/README.md) for the relevant architecture, operations,
   or quality contract;
4. the implementation and tests that currently enforce the behavior.

The Chinese plan under `.claude/plans/` is sequencing history, not current
implementation truth.

## Change workflow

- Keep changes narrow, reviewable, and reversible.
- Use one branch/worktree per independent task and do not overwrite another
  session's work.
- Treat `package.json`, lockfiles, shared contracts, generated localization,
  Android project configuration, CI, and shared docs as high-conflict files.
- Update the owning contract with behavior, platform-boundary, or acceptance
  changes. Link from related docs instead of copying the rule.
- Prefer focused tests while iterating, then run the risk-appropriate gate.
- Stage, commit, push, or publish only intentional files.

## Common loops

```sh
# Web and shared TypeScript
pnpm check:types:ts
pnpm test:unit
pnpm check:lint

# Rust runtime and desktop bridge
pnpm check:rust:format
pnpm check:rust
pnpm test:rust

# Android shell and plugin
pnpm check:android
pnpm mobile:android:test

# Mobile Core
pnpm mobile-core:contract
pnpm mobile-core:build
pnpm mobile-core:verify
```

After changing English localization keys, run `pnpm generate:i18n` before
validation. Mobile Core outputs stay under ignored `.scratch` paths; never
commit generated `.so` files.

## Before publication

Run the normal pull-request-equivalent gate:

```sh
pnpm check:pr
git diff --check
git status --short
```

Add the smallest relevant risk gate:

| Change | Additional validation |
| --- | --- |
| Web layout or navigation | `pnpm test:browser` |
| Rust runtime behavior | focused tests, `pnpm test:rust`, and Clippy |
| macOS daily journey | `pnpm test:macos:p0` |
| macOS resources/package | `pnpm desktop:bundle:macos` |
| Android Kotlin/JNI | `pnpm mobile:android:test` and debug APK build |
| Mobile Core | contract, dual build, evidence verification, and staging |
| Documentation | `pnpm check:docs` |
| CI | `pnpm check:ci` |

CI truth lives in [`.github/workflows/ci.yml`](.github/workflows/ci.yml): pull
requests run `check:pr` on the dedicated self-hosted Apple Silicon runner; daily
or manual inspection runs `check:all` plus browser tests on `macos-15`; `main`
pushes publish 14-day macOS and Android test artifacts.

## Safety invariants

- Never include real subscription URLs, profile content, node labels,
  credentials, tokens, private paths, or raw Controller payloads in repository
  artifacts.
- Tests do not silently enable System Proxy, TUN, listeners, telemetry, or
  remote downloads.
- System Proxy and TUN tests require explicit authorization and proof of exact
  restoration after stop, failure, quit, and forced termination.
- Native capability remains unavailable until the owning platform confirms it.
- Failed activation restores the prior healthy runtime or reaches an explicit
  safe stopped state.
- Desktop, Android, and iOS retain their documented platform authority; the
  WebView never owns VPN lifetime.

## Generated files and cleanup

`node_modules`, `target`, `.scratch`, Gradle outputs, browser attachments, and
native binaries are disposable. Use `trash`, not permanent recursive deletion.
Some files under Android `gen/` are tracked source inputs; check `git status` and
`git ls-files` before cleanup or regeneration. The fixture-backed `pnpm demo`
entry is the model and visual-validation surface; its behavior is not production
runtime evidence.

## Handoff

Record the base and HEAD revisions, dirty paths, tests actually run, unexecuted
hardware gates, artifact identity/checksums, native state restoration, known
defects, and the next verification command. Do not transfer build caches or
private input as project truth.
