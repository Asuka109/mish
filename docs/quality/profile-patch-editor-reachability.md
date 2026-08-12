# Profile Patch Editor reachability audit

| Field      | Value                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Issue      | #453, F2.1                                                                                                                                             |
| Baseline   | `origin/main@8035d5a774fef4b1db0be62d4e546314e848fec2`                                                                                                 |
| Audit date | 2026-08-12                                                                                                                                             |
| Scope      | Production routes, lazy imports, public contracts, adapters, localization, presentation notifications, styles, tests, and runtime/dynamic import paths |

## Decision

No supported production entry point reaches the Profile Patch Editor. The
`/profiles` route and the narrow-shell Profile drawer both load only
`apps/web/src/pages/profiles-page.tsx`; that page has no editor import or
editor action. There is no dynamic import, route, or other supported runtime
path that reaches `ProfilePatchEditor`.

F2.2 is therefore authorized to remove the dead editor path and the exact
dependencies listed below. This authorization does not cover the active
Profile patch persistence/application engine or the active Profile import,
save, cancel, refresh, selection, and file-action paths.

## Reachability trace

| Supported entry               | Production path                                                                                                                           | Result                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Desktop/browser product route | `apps/web/src/app-routes.tsx::ProductRoutes` → `/profiles` → `loadProfilesPage` → `apps/web/src/pages/profiles-page.tsx::ProfilesPage`    | No `ProfilePatchEditor` import or call |
| Narrow desktop shell drawer   | `apps/web/src/components/app-shell.tsx::DrawerProfilesPage` → `../pages/profiles-page`                                                    | Same `ProfilesPage`; no editor import  |
| Mobile navigation             | `apps/web/src/components/mobile-shell.tsx::destinations` → `/profiles`                                                                    | Same product route; no editor import   |
| Profile page actions          | `ProfilesPage` calls `useProfiles()` for create, HTTPS preflight, preview save, refresh, policy, detach, selection, and directory actions | No patch-editor action or lazy import  |

The broad web-tree token scan finds the dead component plus the adapter DTO and
test scaffolding that reference its result type. A direct module-import/call
scan finds no production page, route, or shell entry. The only
`profiles.getPatches` and `profiles.replacePatches` matches are the dead
adapter/bridge/contract implementations, generated lists, tests, and the
obsolete architecture paragraph listed in the manifest below; no supported page
invokes either method.

## Static evidence

The following read-only searches were run at the baseline:

```text
rg -n "ProfilePatchEditor|profile-patch-editor" apps/web/src
  → component plus adapter DTO/test scaffolding; no page imports the component

rg -n 'from .*profile-patch-editor|import\([^)]*profile-patch-editor|<ProfilePatchEditor' \
  apps/web/src --glob '!components/profile-patch-editor.tsx'
  → no matches; no production page/route/shell entry

rg -n "profiles\.getPatches|profiles\.replacePatches" \
  apps packages crates docs
  → contract/generated lists, dead adapter/bridge dispatch, tests, and the
    obsolete boundary documentation; no supported UI entry

rg -n "profile[-_ ]patch|patch-editor" apps/web/src/styles.css
  → no matches; there is no standalone production CSS selector/file to retain

rg -n "import\(" apps/web/src/app-routes.tsx apps/web/src/components/app-shell.tsx
  → only the supported page lazy imports (including profiles-page); no editor
    module import
```

The active Rust patch engine has separate reachability through profile records,
repository load/update, route-catalog generation, refresh rebinding, activation
runtime generation, and local backup/restore. Those paths are intentionally
retained below.

## Exact F2.2 deletion manifest

### Web editor and adapters

- Delete `apps/web/src/components/profile-patch-editor.tsx` in full. This
  removes the exported `ProfilePatchEditor` and its editor-only helpers and
  style recipe: `PatchFormDialog`, `OperationFields`, `SelectField`,
  `MemberPicker`, `patchStyles`, `defaultOperation`, `changeRuleKind`,
  `operationIsComplete`, `operationTarget`, `patchKindLabel`,
  `patchStatusLabel`, `patchBadge`, `validationLabel`, `move`, and the local
  `PatchKind`/props types.
- In `apps/web/src/data/profile-provider.tsx`, remove the editor result type
  `ProfilePatchEditorResult`, the `"patch-save"` operation variant,
  `ProfileContextValue.loadPatches`/`replacePatches`, the `loadPatches` and
  `replacePatches` callbacks (including `cancelledPatchEditor`), and their
  context/dependency entries. Keep all other profile operations and
  cancellation handling.
- In `apps/web/src/data/rpc-profile-client.ts`, remove patch DTO imports and
  `RpcProfileClient.getPatches`/`replacePatches`. Keep `getRoutes`,
  `preflightHttps`, `savePreview`, and the other active methods.
- In `apps/web/src/data/fixture-profile-client.ts`, remove patch DTO imports,
  `capabilities.patches`, `getPatches`, `replacePatches`, and the
  `fixturePatchEditor` object. Keep the fixture's `"user-patches"` runtime
  provenance layer and all active profile fixture behavior.
- Remove the corresponding dead test scaffolding: patch methods from the
  `ProfileClient` test doubles in `apps/web/src/app.test.tsx`; the
  `ProfilePatchEditorDto` import, `capabilities.patches`, `emptyPatches`, and
  patch mocks in `apps/web/src/pages/profiles-page.test.tsx`; the patch request
  segment and patch capability fixture in
  `apps/web/src/data/rpc-profile-client.test.ts`; and the editor file read and
  section test in `apps/web/src/platform/responsive-shell.test.ts`.

### TypeScript contracts and generated bridge contract

- In `packages/contracts/src/index.ts`, delete the editor-only DTO block from
  `ProfilePatchAuthoritySchema` through `ProfilePatchEditorDto`, including
  `ProfilePatchEntity*`, `ProfilePatchCatalog*`, `CommonRuleType`,
  `StructuredRule`, `ProfilePatchOperation`, `ProfilePatch`, validation/status
  DTOs, and `ProfilePatchEditor` schemas/types. Delete
  `ProfileReplacePatchesCommandSchema`, the `profiles.getPatches` and
  `profiles.replacePatches` entries in `profileRpcMethods`, and the matching
  `ProfileClient.getPatches`/`replacePatches` signatures. Remove only
  `ProfileCapabilitiesSchema.patches`; the other capability fields remain.
- In `packages/bridge-protocol/bridge-protocol.json`, remove the two public
  methods. Regenerate (do not hand-edit) the matching method lists in
  `packages/contracts/src/generated/bridge-protocol.ts` and
  `crates/desktop-bridge/src/generated/bridge_protocol.rs`.
- Removing public methods is a bridge contract change. F2.2 must update the
  source and generated protocol version/minimums from the current 37 to the
  next agreed version (38 if no compatibility policy is chosen), then run the
  bridge-protocol generator/check.

### Rust bridge/service endpoint

- In `crates/desktop-bridge/src/protocol.rs`, remove the `ProfilePatch` import,
  `ProfilePatchAuthorityParams`, `ProfileReplacePatchesParams`, the
  `profiles.getPatches` and `profiles.replacePatches` dispatch arms, and the
  now-unused `valid_patch_authority`/`valid_sha256` helpers. Do not touch the
  adjacent `profiles.getRoutes`, `profiles.preflightHttps`, or `profiles.save`
  handlers.
- In `crates/desktop-bridge/src/profile_activation.rs`, remove the editor DTO
  and `ProfilePatch` imports and `ProfileActivationCoordinator::replace_patches`.
  Keep activation, refresh, route-catalog, and runtime patch application.
- In `crates/profile/src/service.rs`, remove the editor DTO/`ProfilePatch`
  imports, `ProfileCapabilities::patches` and its snapshot value, and the
  editor-only `patch_editor`, `replace_patches`,
  `replace_patches_authorized`, and `authorized_patch_record` methods. Keep
  `ProfilePatchError`, `activation_record`, `route_catalog`, refresh rebinding,
  and all preflight/save/profile lifecycle methods.

### Rust patch module: editor projection only

In `crates/profile/src/patch.rs`, remove the public editor projection and its
builder:

- `ProfilePatchAuthority` and `ProfilePatchAuthority::new`;
- `PatchEntityView`, `PatchGroupView`, `PatchRuleView`,
  `ProfilePatchCatalog`;
- `PatchStatus`, `ProfilePatchView`, `ProfilePatchEditor`;
- `profile_patch_editor`; and
- `PatchCatalog::view`.

`PatchEntityKind`, `PatchValidationResult`, `PatchValidationCode`, and
`PatchActivationImpact` are currently used by `build_catalog`/`evaluate_patches`
and `apply_profile_patches`; retain them as evaluator-internal types (remove
public/serialization exposure only if the implementation still needs it).
Retain `ProfilePatchSet`, `ProfilePatch`, `ProfilePatchOperation`,
`RuleInsertPosition`, `StructuredRule`, `CommonRuleType`,
`bind_and_apply_profile_patches`, `apply_profile_patches`, validation, and
`ProfilePatchError`.

### Presentation, localization, and generated artifacts

- Remove `profile.patch-load-failed`, `profile.patch-save-failed`, and
  `profile.patch-saved` from `packages/presentation-schema/presentation.schema.json`;
  regenerate `packages/contracts/src/generated/presentation.ts` and
  `crates/presentation-contract/src/generated.rs`.
- Remove the three corresponding cases from
  `apps/web/src/data/notification-registry.ts` and their sample entries from
  `apps/web/src/data/notification-registry.test.ts`.
- In both `apps/web/src/i18n/en/index.ts` and `apps/web/src/i18n/zh/index.ts`,
  remove the `profiles` keys consumed only by the dead editor:
  `patchActivationBlocked`, `patchAdd`, `patchAddTitle`, `patchAllSaved`,
  `patchCount`, `patchDisable`, `patchDisabled`, `patchDiscard`,
  `patchDiscardDescription`, `patchDiscardTitle`, `patchEdit`, `patchEditTitle`,
  `patchEditorDescription`, `patchEditorTitle`, `patchEmptyDescription`,
  `patchEmptyTitle`, `patchEnable`, `patchEnabled`, `patchFixture`,
  `patchFormDescription`, `patchGroupAdd`, `patchGroupLabel`,
  `patchGroupMembers`, `patchGroupOrder`, `patchGroupReorder`, `patchInvalid`,
  `patchMembers`, `patchMembersDescription`, `patchMoveDown`, `patchMoveUp`,
  `patchPolicyGroup`, `patchPolicyGroupsTarget`, `patchPosition`, `patchPrefix`,
  `patchReset`, `patchRuleDelete`, `patchRuleDisable`, `patchRuleInsert`,
  `patchRuleProvider`, `patchRuleSummary`, `patchRuleTarget`, `patchRuleType`,
  `patchRuleValue`, `patchRuleValueDescription`, `patchSave`,
  `patchSourceRule`, `patchRulesTarget`, `patchStale`, `patchSuffix`,
  `patchType`, `patchUnsavedChanges`, `patchUnsavedValidation`, `patchUpdate`,
  `patchValidationConflict`, `patchValidationDisabled`,
  `patchValidationDuplicateLabel`, `patchValidationDuplicateTarget`,
  `patchValidationOrder`, `patchValidationReference`,
  `patchValidationRevision`, `patchValidationTarget`, `patchValidationValid`,
  `patchValidationValue`, and `patches`, plus the notification-only
  `patchLoadFailed`, `patchSaveFailed`, and `patchSaved`. Regenerate
  `apps/web/src/i18n/i18n-types.ts`.
- Do not remove the active `settingsPage.backupFlow.patches`/
  `patchesDescription` keys, dashboard count `patches`, or any generic
  `"user-patches"` runtime/provenance terminology.

### Tests and documentation requiring coordinated cleanup

- In `crates/profile/src/patch.rs`, preserve the active ordering/conflict and
  revision-binding behavior tests while replacing editor-only catalog/status
  setup with deterministic IDs or direct `apply_profile_patches` assertions.
  Delete only `source_rule_summaries_do_not_echo_unknown_rule_payloads`, which
  serializes the dead editor projection.
- Preserve and refactor away editor lookup in
  `crates/profile/tests/profile_foundation.rs::failed_patch_pointer_commit_keeps_the_prior_patch_set_authoritative`
  and `crates/desktop-bridge/tests/mihomo_activation.rs::patch_preview_and_activation_use_the_same_runtime_generator`.
  Preserve the active LKG behavior in
  `crates/profile/tests/profile_service.rs::patches_round_trip_and_missing_refresh_targets_preserve_lkg`
  using direct patch-set setup; delete
  `patch_authority_and_editor_serialization_do_not_expose_secrets`; remove
  only the patch-editor branch from
  `every_profile_write_entry_rejects_a_concurrent_shared_authority_holder`.
- In `crates/desktop-bridge/tests/bridge_protocol.rs`, remove the patch-specific
  requests from `rejects_unauthenticated_and_malformed_requests` and
  `authenticated_profile_rpc_exposes_only_safe_operations_and_redacted_errors`.
  Keep the surrounding authentication, preflight, save, provider, and
  redaction coverage.
- Remove the obsolete Protocol version 10 editor paragraph from
  `docs/architecture/frontend-platform-boundary.md`. Update only the editor/RPC
  bullets in `docs/quality/production-web-validation.md`; retain its active
  patch persistence, conflict, refresh-stale, and activation coverage. The
  Profile domain documentation and P1 editor PRD text require a product-doc
  decision, not deletion of the active patch engine, and are outside F2.1.

## Active paths that must remain

The supported Profile edit-like flow is the current import/create dialog, not
the dead patch editor:

- `apps/web/src/pages/profiles-page.tsx::openCreate`, `createProfile`, and
  `closeCreate` keep the create form and Cancel/discard reset behavior.
- `ProfilesPage::openHttpsImport`, `preflightHttps`, `savePreview`, and
  `closeImport` keep HTTPS preflight, preview, Save Profile, and Cancel/close
  discard behavior. Profile-card refresh, scheduling, selection, detach, and
  directory actions also remain.
- `apps/web/src/data/profile-provider.tsx` keeps `preflightHttps`,
  `savePreview`, and the shared command/cancellation machinery.
- `apps/web/src/data/rpc-profile-client.ts` keeps
  `profiles.preflightHttps`/`profiles.save`; `crates/desktop-bridge/src/protocol.rs`
  keeps those handlers; and `crates/profile/src/service.rs` keeps
  `preflight_https`/`save_preview` and source persistence.
- The durable patch layer remains reachable from
  `ProfileRecord.patches`, repository patch-set/index persistence,
  `bind_and_apply_profile_patches`/`apply_profile_patches`, route-catalog and
  activation runtime generation, refresh rebinding, and local backup/restore.
  The `"user-patches"` provenance layer and generic backup patch scope remain.

## F2.2 safety statement

The audit found no supported runtime entry to the editor, so F2.2 is safely
unblocked after applying the manifest and preserving the guardrails above.
F2.2 must regenerate bridge, presentation, and i18n artifacts and run the
active Profile import/save/cancel and patch-engine tests after the deletion.

## F2.3 persistent regression gate

The deletion is now guarded by `pnpm check:profile-patch-editor`, which runs as
part of `pnpm check:docs` and therefore the pull-request gate. The gate keeps a
small product/static inventory rather than a second route scanner. It checks the
supported `/profiles` route and active import/save path, rejects the exact dead
editor route/import, public bridge methods, presentation IDs, localization
keys, and generated contract tokens, and verifies that the production Web graph
does not reach test-only sources. Bridge, presentation, and i18n freshness
remain owned by their existing generators and checks; this gate verifies that
their generated outputs still contain no deleted editor surface.

`scripts/check-profile-patch-editor-removal.test.ts` supplies one clean
repository fixture and bounded negative fixtures for a dangling route, import,
public contract, localization key, generated binding, and production test-only
reachability. The positive fixture deliberately retains the active
`ProfilePatchSet` persistence/application layer and Profile import/save/cancel
flow, so the guard cannot be satisfied by deleting the supported Profile path.

The evidence is static and deterministic. It does not claim real macOS, Core,
network, signing, packaging, or device behavior.
