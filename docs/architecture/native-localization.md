# Native localization contracts

## Boundary

Rust-authoritative Settings remains the only persisted language authority. The
native presentation slice consumes canonical `en` and `zh-CN` locale IDs plus a
monotonic settings revision; it does not persist or mutate another locale.

`packages/presentation-schema/presentation.schema.json` owns the bounded locale,
native message, typed argument, and notification-action identifiers shared
across runtimes. `scripts/generate-presentation-contract.ts` emits exhaustive
Rust and TypeScript bindings. `pnpm check:i18n` fails when either generated file
drifts, a locale resource is absent, a catalog has an extra or missing key, or a
message's interpolation arguments differ from the schema.

This schema deliberately does not cut application events or notifications over
to a new payload. Semantic event data and action transport remain Issue #156
Stage 5.

## Native translation

`mish-native-i18n` embeds English and Simplified Chinese YAML resources through
`rust-i18n`. Callers construct generated typed messages and pass a generated
locale to every translation. Production code never calls or reads the
process-global locale.

English fallback exists only for an unavailable or corrupted embedded resource.
Supported catalogs are exhaustive at CI time, so normal rendering cannot use
fallback to conceal an incomplete Chinese catalog. Profile, node, and service
labels remain opaque user-provided values and are interpolated without
translation.

Web-only copy remains in the existing `typesafe-i18n` catalogs. The neutral
schema does not move the React catalog into Rust or require the two runtimes to
share an implementation library.

## Native projection lifecycle

Status-bar initialization creates the Settings receiver before reading the
initial snapshot. Updates published while native handles are being constructed
therefore remain queued. The retained status model carries the latest revision
and rejects equal or older snapshots.

The application menu and status menu retain their original native item handles.
Language changes update text on the Tauri main thread without replacing command
IDs, accelerators, roles, enabled state, checked state, or user-provided labels.
The same observer path handles restore, another settings client, and subsequent
language revisions without restarting Mish.

## Size evidence

The optimized binary and packaged application are measured from the same
Apple-Silicon toolchain with `pnpm desktop:build:macos`, using starting commit
`ffe5ecc` before this slice and the completed pre-integration task branch:

| Artifact | Before | After | Delta |
| --- | ---: | ---: | ---: |
| `Mish.app/Contents/MacOS/mish-desktop` | 29,810,480 bytes | 29,995,712 bytes | +185,232 bytes (+0.62%) |
| `Mish.app` allocated size | 115,580 KiB | 115,764 KiB | +184 KiB (+0.16%) |

Both application bundles passed the repository macOS bundle builder; the
task-branch bundle additionally passed `pnpm desktop:bundle:verify:macos`.
