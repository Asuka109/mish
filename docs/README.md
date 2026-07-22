# Mish Documentation

Refreshed 2026-07-21 against `main` at `8b2f519`.

Load the smallest document set that answers the task. Code, tests, manifests,
and CI describe current implementation; product and architecture documents
describe intended contracts. When they disagree, record the difference instead
of treating an implementation accident as intent.

## Start by task

| Task                      | Read first                                                                                       | Then, only if needed                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product behavior or copy  | [`../PRODUCT.md`](../PRODUCT.md)                                                                 | [`product/status-experience.md`](product/status-experience.md), [`product/prds/`](product/prds/)                                                                                                                             |
| Visual/UI work            | [`../DESIGN.md`](../DESIGN.md)                                                                   | [`architecture/tailwind-variants.md`](architecture/tailwind-variants.md), [`design/component-patterns.md`](design/component-patterns.md), [`design/mobile-navigation-and-layout.md`](design/mobile-navigation-and-layout.md) |
| Local development         | [`../development.md`](../development.md)                                                         | [`operations/development-commands.md`](operations/development-commands.md), [`../bootstrap.md`](../bootstrap.md)                                                                                                             |
| Web/desktop boundary      | [`architecture/frontend-platform-boundary.md`](architecture/frontend-platform-boundary.md)       | [`architecture/desktop-bootstrap.md`](architecture/desktop-bootstrap.md)                                                                                                                                                     |
| Mihomo lifecycle/API      | [`architecture/mihomo-controller-integration.md`](architecture/mihomo-controller-integration.md) | Status, Traffic, Events, or Diagnostics contract below                                                                                                                                                                       |
| Profiles and settings     | [`architecture/profile-domain.md`](architecture/profile-domain.md)                               | [`architecture/settings-contracts.md`](architecture/settings-contracts.md), [`architecture/local-backup-restore.md`](architecture/local-backup-restore.md)                                                                   |
| macOS native behavior     | [`architecture/native-status-bar-lifecycle.md`](architecture/native-status-bar-lifecycle.md)     | TUN, packaging, network/DNS, or sidebar document below                                                                                                                                                                       |
| Android/mobile            | [`architecture/mobile-runtime-integration.md`](architecture/mobile-runtime-integration.md)       | [`architecture/mobile-core-abi.md`](architecture/mobile-core-abi.md), [`operations/android-phase0-prototype.md`](operations/android-phase0-prototype.md), [`quality/mobile-validation.md`](quality/mobile-validation.md)     |
| Validation/release claims | The target-specific quality document                                                             | [`quality/prototype-validation.md`](quality/prototype-validation.md) only for `sketch/` changes                                                                                                                              |

## Contract index

### Architecture

- [`frontend-platform-boundary.md`](architecture/frontend-platform-boundary.md) —
  ownership across Web, RPC, desktop bridge, Tauri, and native layers.
- [`tailwind-variants.md`](architecture/tailwind-variants.md) — production
  styling ownership, merge/source rules, and bounded CSS exceptions.
- [`desktop-bootstrap.md`](architecture/desktop-bootstrap.md) — offline assets,
  local origin, browser launch, authentication, and threat model.
- [`mihomo-controller-integration.md`](architecture/mihomo-controller-integration.md)
  — pinned Controller API, process lifecycle, activation, and reconciliation.
- [`profile-domain.md`](architecture/profile-domain.md) — profile sources,
  validation, persistence, patches, providers, and activation seam.
- [`status-data-contracts.md`](architecture/status-data-contracts.md),
  [`traffic-data-contracts.md`](architecture/traffic-data-contracts.md),
  [`events-data-contracts.md`](architecture/events-data-contracts.md), and
  [`diagnostics-data-contracts.md`](architecture/diagnostics-data-contracts.md)
  — observable DTO and failure semantics by product area.
- [`settings-contracts.md`](architecture/settings-contracts.md) and
  [`local-backup-restore.md`](architecture/local-backup-restore.md) — settings,
  persistence, backup, restore, and native file boundaries.
- [`native-status-bar-lifecycle.md`](architecture/native-status-bar-lifecycle.md),
  [`network-dns-observation.md`](architecture/network-dns-observation.md),
  [`local-proxy-debugging.md`](architecture/local-proxy-debugging.md), and
  [`macos-tun-helper.md`](architecture/macos-tun-helper.md) — macOS-specific
  lifecycle, observation, debugging, and privileged-operation contracts.
- [`mobile-runtime-integration.md`](architecture/mobile-runtime-integration.md)
  and [`mobile-core-abi.md`](architecture/mobile-core-abi.md) — mobile platform
  ownership, native Core ABI, artifact identity, and lifecycle.

### Operations and quality

- [`operations/development-commands.md`](operations/development-commands.md) —
  authoritative command catalog derived from root `package.json`.
- [`operations/macos-packaging.md`](operations/macos-packaging.md) and
  [`quality/macos-p0-acceptance.md`](quality/macos-p0-acceptance.md) — macOS
  packaging, signing, installation, daily journey, and recovery.
- [`operations/android-phase0-prototype.md`](operations/android-phase0-prototype.md)
  and [`quality/mobile-validation.md`](quality/mobile-validation.md) — Android
  build/device procedure and mobile evidence levels.
- [`quality/production-web-validation.md`](quality/production-web-validation.md),
  [`quality/native-sidebar-validation.md`](quality/native-sidebar-validation.md),
  and [`quality/prototype-validation.md`](quality/prototype-validation.md) —
  production Web, native visual, and retained-sketch gates respectively.

## Planning and research

- [`product/prds/`](product/prds/) preserves the 2026-07-18 product planning
  baseline. It is useful for intent and requirement IDs, not current
  implementation status.
- [`research/`](research/) preserves source-backed investigations. Load a study
  only when its upstream evidence or rationale is needed.
- [`../.claude/plans/development-plan.md`](../.claude/plans/development-plan.md)
  is a superseded high-level plan retained as a short historical record.
- [`../sketch/`](../sketch/) is an interaction reference; its fixture data is not
  a runtime contract.

## Maintenance

- Put each fact in the narrowest owning document and link instead of copying.
- Keep commands in the root manifest/command catalog and implementation status
  in code, tests, CI, or quality evidence.
- Update a contract and its acceptance gate in the same behavior change.
- Preserve assumptions and unresolved intent explicitly. Repository docs are in
  English; the retained Claude plan is the only planned exception.
