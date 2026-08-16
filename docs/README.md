# Mish Documentation

This index describes the current TypeScript product graph. Code, manifests,
tests, and CI are the implementation authority; these documents define the
ownership and evidence contracts around that graph. Superseded implementation
notes are not linked as current authority.

## Start here

| Question                                       | Current authority                                                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is admitted into production?              | [`architecture/typescript-cutover-admission.md`](architecture/typescript-cutover-admission.md)                                                                                                                       |
| How do Web, Electron, and RN share boundaries? | [`architecture/frontend-platform-boundary.md`](architecture/frontend-platform-boundary.md)                                                                                                                           |
| Where does lifecycle state live?               | [`architecture/cross-platform-product-authority.md`](architecture/cross-platform-product-authority.md) and [`architecture/state-machine-kernel.md`](architecture/state-machine-kernel.md)                            |
| How are session and projections composed?      | [`architecture/runtime-state-ownership.md`](architecture/runtime-state-ownership.md)                                                                                                                                 |
| How are effects tested and replayed?           | [`architecture/transcript-driven-system-tests.md`](architecture/transcript-driven-system-tests.md)                                                                                                                   |
| How do I develop and run gates?                | [`../development.md`](../development.md) and [`operations/development-commands.md`](operations/development-commands.md)                                                                                              |
| How is the product surface validated?          | [`quality/production-web-validation.md`](quality/production-web-validation.md), [`quality/mobile-validation.md`](quality/mobile-validation.md), and [`operations/macos-packaging.md`](operations/macos-packaging.md) |
| What is the visual contract?                   | [`../DESIGN.md`](../DESIGN.md), [`design/component-patterns.md`](design/component-patterns.md), and [`product/status-experience.md`](product/status-experience.md)                                                   |

## Architecture contracts

- [`architecture/typescript-cutover-admission.md`](architecture/typescript-cutover-admission.md)
  defines the retirement denylist, POC isolation, and confirmation-only
  acceptance boundary.
- [`architecture/frontend-platform-boundary.md`](architecture/frontend-platform-boundary.md)
  defines the host seams and production import direction.
- [`architecture/cross-platform-product-authority.md`](architecture/cross-platform-product-authority.md)
  defines the shared contract, XState actor, Query projection, and
  presentation ownership.
- [`architecture/runtime-state-ownership.md`](architecture/runtime-state-ownership.md)
  defines the single session authority and cache/presentation split.
- [`architecture/state-machine-kernel.md`](architecture/state-machine-kernel.md)
  records the XState-only lifecycle convention and completed retirement of
  repository-owned duplicate runtimes.
- [`architecture/transcript-driven-system-tests.md`](architecture/transcript-driven-system-tests.md)
  defines bounded invocation/result transcripts, privacy checks, and replay.
- [`architecture/documentation-evidence-contract.md`](architecture/documentation-evidence-contract.md)
  defines how dated or historical claims are kept separate from active truth.

The page-level contracts are [`status-data-contracts.md`](architecture/status-data-contracts.md),
[`traffic-data-contracts.md`](architecture/traffic-data-contracts.md),
[`events-data-contracts.md`](architecture/events-data-contracts.md),
[`profile-domain.md`](architecture/profile-domain.md),
[`settings-contracts.md`](architecture/settings-contracts.md), and
[`local-backup-restore.md`](architecture/local-backup-restore.md).

## Operations and quality

- [`operations/development-commands.md`](operations/development-commands.md)
  is the command catalog derived from `package.json`.
- [`operations/macos-packaging.md`](operations/macos-packaging.md) documents
  the disposable Electron DMG fixture and its cleanup boundary.
- [`quality/production-web-validation.md`](quality/production-web-validation.md)
  records Web navigation, contract replay, and graph gates.
- [`quality/mobile-validation.md`](quality/mobile-validation.md) records RN
  type/test, dual-ABI, and root-free admission gates.
- [`quality/macos-platform-transcript-fixtures.md`](quality/macos-platform-transcript-fixtures.md)
  records privacy and replay rules for opt-in host fixtures.

## Product and history

Product intent is in [`product/status-experience.md`](product/status-experience.md)
and [`product/prds/`](product/prds/). Research under [`research/`](research/)
is historical context only and cannot change the production graph. Any
superseded document retained for tracker evidence must say so in its own
heading; it is not linked above as an implementation authority. Issue #343 was
superseded; it is retained only as that historical decision context. Issue #373
was rejected and is not a current implementation dependency.

## Maintenance

Keep commands in the root manifest and keep ownership claims in the narrowest
contract. Update the contract, transcript/replay fixture, and gate together.
Do not add compatibility shims, duplicate session authorities, or native
business lifecycle to make a retired path appear present.
