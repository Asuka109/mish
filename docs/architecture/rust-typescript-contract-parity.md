# Rust-to-TypeScript contract parity

The migration inventory and parity gate provide a closed, machine-readable contract boundary for the later TypeScript Runtime, Electron, and React Native work. The gate is tooling-only: it does not migrate domain behavior, invoke host effects, contact networks, or publish artifacts.

## Authority and coverage

`packages/contracts/migration-inventory.json` is the checked-in inventory. Every entry declares its authority, TypeScript/Rust projections, required parity dimensions, compatibility envelope, privacy allowlist, and bounded fixture. Generated families are parser-backed by their JSON schema and generator; manual families use an explicit shape/enum/bound manifest checked against Rust DTOs and TypeScript Zod schemas.

| Family                 | Authority                                                     | Evidence                                              | Fixture                     |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------- | --------------------------- |
| Android platform facts | `packages/android-platform-facts/android-platform-facts.json` | generator output + source field/enum/bound projection | authoritative `goldenFacts` |
| Bridge protocol        | `packages/bridge-protocol/bridge-protocol.json`               | generator output + capability/method projection       | bounded source projection   |
| Presentation           | `packages/presentation-schema/presentation.schema.json`       | generator output + ID/optional-field projection       | bounded source projection   |
| Mobile events/traffic  | Rust DTOs + `packages/contracts/src/index.ts`                 | parser-backed field/null/enum/bound evidence          | synthetic shape fixture     |
| Mobile route/VPN       | Rust DTOs + `packages/contracts/src/index.ts`                 | parser-backed field/null/enum/bound evidence          | synthetic shape fixture     |
| Runtime/status         | Rust DTOs + `packages/contracts/src/index.ts`                 | parser-backed field/null/enum/bound evidence          | synthetic shape fixture     |
| Settings               | Rust DTOs + `packages/contracts/src/index.ts`                 | parser-backed field/null/enum/bound evidence          | synthetic shape fixture     |

Each entry must account for fields, enum variants, discriminants/tagging, optional/null semantics, numeric/string bounds, collection limits, redaction/privacy, compatibility/version envelopes, and generated files. `discriminants: none` is an explicit assertion for non-tagged contracts; semantic presentation events assert `kind` plus Rust `tag=kind,content=data`.

## Gate and fixtures

Run the gate with:

```sh
pnpm check:contract-parity
node --test scripts/check-contract-parity.test.ts
```

The gate canonicalizes JSON with sorted object keys and stable array order, hashes fixture payloads when a shape hash is declared, rejects unknown fields, and enforces a 64 KiB fixture limit. Fixture traversal rejects credentials, private keys, tokens, profile bytes, raw platform output, absolute paths, and arbitrary endpoints. Synthetic fixtures contain only bounded shape evidence; they are not claims about live VPN, Core, network, filesystem, or OS behavior.

Generated entries run their generator twice and fail on stale or non-deterministic output. Manual entries compare Rust serde names (including `rename_all` and explicit renames) with TypeScript object fields, nullability, optionality, enums, and declared bound markers. Source projections additionally reject missing/extra fields, enum drift, compatibility version drift, and changed redacted shapes.

## Evidence limits

The parser intentionally operates on checked-in source text and generated artifacts. It is not a replacement for Rust compiler reflection or runtime serialization tests. A DTO whose semantics are assembled by an adapter still requires an explicit manifest entry and fixture; adapter/native behavior is outside this gate. Real-host acceptance and transcript evidence remain separate gates under the system-test boundary.

The migration gate is expected to fail closed during migration. A contract change must update the authority, generated artifacts (when applicable), inventory evidence, fixture, and focused tests in one reviewable change.
