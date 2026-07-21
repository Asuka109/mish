# PRD 02: Profiles and Routes

## Metadata

- Status: Draft for product review
- Implementation status: Not authoritative; see [PRD suite](README.md)
- Version: 0.1
- Date: 2026-07-18
- Destinations: Profiles and Routes

## Product bet

For a user who receives configuration from a provider, a repository, or a local
file, turn that source into a validated, reversible runtime profile and expose
its full policy-group hierarchy without flattening or guessing. Success means a
valid profile can be imported and activated safely, while every route change
remains scoped to an explicit group.

## Background

Clash Verge Rev places subscription import, global merge/script extensions, and
runtime profile actions on one page. Stash separates configuration files from
policy groups and provides strong status-menu access to `group -> child`.
Shadowrocket makes protocol-level node creation highly accessible on mobile.

This product will prioritize profile sources and Mihomo-compatible configuration
over a broad manual protocol editor. Profiles own provenance and activation;
Routes owns the runtime group tree and selection.

## Scope

### P0

- Import from HTTPS URL and local file.
- Validate, preview summary, save, activate, update manually, and delete.
- Display provenance, last attempt, last success, validation result, and active
  state.
- Browse, search, and select within the complete runtime policy-group tree.
- Group- and node-scoped latency tests.

### P1

- Scheduled profile refresh with explicit policy and backoff.
- Clipboard/deep-link import and safe redaction.
- Status-bar profile and group selection.
- Backup/export of non-secret profile metadata and user-owned local sources.

### Later

- QR import on mobile.
- Manual protocol-specific node authoring.
- Merge templates, JavaScript transforms, remote transform marketplaces, or
  provider-controlled native extensions.

## Implemented frontend slice

The production React Routes destination now provides the policy-group workspace
for the P0 browsing contract. It renders
nested group-to-group and group-to-node relationships, distinguishes every
specified group type, searches complete Unicode labels, keeps sorting local to
each expanded group, and permits manual selection only through Selector groups.
It rejects inconsistent graphs before rendering and includes a 160-node scale
fixture whose collapsed children are not mounted.

The fixture adapter supports isolated demo selection for interaction tests. The
desktop RPC Status adapter enables group-scoped selection only when the bridge
advertises a real Controller command source. Status shortcuts and Routes share
that client seam, pending ownership, typed failures, and confirmed snapshots.
Each expanded group now owns a delay-test toolbar. The desktop bridge captures
that group's current direct children, applies the visible fixed P0 probe policy,
publishes per-child progress and timestamped outcomes, and supports honest
cancellation. Results are revalidated against the active profile catalog before
publication. Browser fixtures keep the command disabled instead of simulating a
desktop probe. Custom URLs, credentials, timeouts, scheduled probes, and a global
“test all nodes” action remain outside P0.

The production Profiles destination now lists the private app-data repository,
preflights HTTPS and user-selected local YAML sources, shows a redacted preview,
saves valid previews, refreshes persisted sources manually, and deletes inactive
profiles after confirmation. Browser mode remains explicitly fixture-only and
does not simulate local-file import or activation. Desktop activation reloads a
repository-validated artifact and exposes a typed transactional command state.
Deleting the active profile requires either successful activation of a selected
replacement or an explicit safe stop before deletion becomes available. The
Status profile selector uses the same Profiles command seam.

The P1 Profiles slice keeps automatic source refresh off by default and offers
only fixed six-hour, twelve-hour, daily, and weekly schedules for HTTPS sources.
The desktop application coordinator persists next run and last success/failure,
applies bounded exponential backoff, and shares a per-profile gate with manual
refresh and activation. Profiles also distinguishes that source lifecycle from
current-runtime proxy/rule providers: safe provider health is read-only,
update-one/update-all are explicitly scoped to current profile/runtime
authority, partial failures remain per-provider, and a fresh inventory is
required before success is reported. Browser fixtures perform neither
background refresh nor provider updates.

The P1 structured-patch slice adds a summary-first editor for common rules and
selector groups. Patches are independently persisted, enabled/disabled,
reordered, edited, deleted, or reset as one revision-bound validated draft.
Refresh revalidates without rewriting patch intent; stale or conflicting
patches block the new revision while the active last-known-valid runtime keeps
running. Protocol-specific proxy authoring, arbitrary paths, scripts, templates,
and raw YAML fallback remain outside this slice.

## Requirements: Profiles

| ID         | Priority | Requirement                                                                                                        | Acceptance criteria                                                                                                                                                                                                       |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PROF-F-001 | P0       | Profiles shall accept HTTPS URL and local-file sources.                                                            | Given a supported source, when the user imports it, then source type and provenance are recorded and the existing active profile is not changed before validation succeeds.                                               |
| PROF-F-002 | P0       | Import shall validate syntax, required semantics, and supported core compatibility before activation.              | Given malformed or unsupported input, when validation finishes, then actionable errors identify the failing area and no runtime profile is replaced.                                                                      |
| PROF-F-003 | P0       | The user shall preview a normalized summary before first activation.                                               | The preview includes profile label, group count, proxy count, rule count, warnings, source type, and sensitive-data notice without exposing stored secrets.                                                               |
| PROF-F-004 | P0       | Profile activation shall be transactional.                                                                         | Given profile B fails runtime activation, when profile A was previously healthy, then A remains or is restored and the failure is recorded against B.                                                                     |
| PROF-F-005 | P0       | Profile list rows shall expose active, valid, stale, updating, warning, and error states.                          | Given a failed refresh after a previous success, then the last known valid copy remains distinguishable from the failed latest attempt.                                                                                   |
| PROF-F-006 | P0       | Manual update shall preserve the last known valid profile until the new version is validated and activated.        | Given a remote source returns invalid content, when Update is run, then runtime traffic continues on the prior valid copy and the user sees the failed attempt.                                                           |
| PROF-F-007 | P0       | Deleting an inactive profile shall remove its local profile-scoped derived state after confirmation.               | Given a profile is inactive, when deletion is confirmed, then source, cached configuration, route selections, and group-usage data follow the documented retention policy.                                                |
| PROF-F-008 | P0       | Deleting the active profile shall require choosing or reaching a safe replacement state.                           | Given the active profile is deleted, then capture is stopped or a validated replacement is activated before the old runtime configuration disappears.                                                                     |
| PROF-F-009 | P1       | Scheduled refresh shall be user-configurable per profile and shall use bounded retries.                            | Given repeated source failure, then refresh backs off, retains the last valid copy, and never loops aggressively.                                                                                                         |
| PROF-F-010 | P1       | Profile source secrets shall be redacted in ordinary UI, events, and diagnostic export.                            | Tests with URL credentials, query tokens, proxy credentials, and embedded headers show no raw secret in screenshots or default exports.                                                                                   |
| PROF-F-011 | P1       | Remote profiles shall expose an explicit fetch policy.                                                             | Given a remote source, then its user agent, timeout, update interval, TLS validation, auto-update policy, and direct/System Proxy/core-proxy fetch route are visible and default to the safest supported behavior.        |
| PROF-F-012 | P1       | Users shall be able to inspect the generated runtime profile without editing it in place.                          | Given activation succeeds, when the runtime view opens, then the effective generated configuration and its profile/transform provenance are readable, secrets are redacted, and source editing remains a separate action. |
| PROF-F-013 | P1       | Profiles shall support bounded batch selection for reversible lifecycle actions.                                   | Given multiple inactive profiles, when batch mode is entered, then selection count and action scope remain visible; active-profile deletion still follows `PROF-F-008`.                                                   |
| PROF-F-014 | P0       | Import shall classify portable profile policy separately from application- and platform-owned settings.            | Given a profile contains absolute paths, listeners, ports, controller values, TUN enablement, or other device integration, then preflight states what is preserved, overridden, disabled, or rejected before activation.  |
| PROF-F-015 | P1       | Rule-provider lifecycle shall expose source type, behavior, record count, last result, and scoped update commands. | Given one or more rule providers, when Update or Update All runs, then scope and progress are visible, failures are provider-specific, and the prior valid data remains usable.                                           |
| PROF-F-016 | P1       | Common proxy, group, and rule edits shall be stored as inspectable profile-scoped patches.                         | Given a remote source is edited locally, then the immutable source remains available and each insertion, deletion, reorder, or field override can be reviewed and removed independently.                                  |

## Requirements: Routes

| ID           | Priority | Requirement                                                                                                                                        | Acceptance criteria                                                                                                                                                                   |
| ------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ROUTE-F-001  | P0       | Routes shall render the complete visible policy-group tree for the active profile.                                                                 | Given nested groups, when the user expands the tree, then parent-child structure and group type are preserved and no group is flattened into a global node list.                      |
| ROUTE-F-002  | P0       | Every selection command shall identify a group and one current child of that group.                                                                | Given child C is not in group G at command time, when selection is attempted, then it fails safely and the refreshed group is shown.                                                  |
| ROUTE-F-003  | P0       | Routes shall distinguish selector, URL test, fallback, load-balance, relay, direct, reject, and unsupported types when exposed by the pinned core. | Group type is communicated by text; unsupported behavior is not presented as a selectable manual selector.                                                                            |
| ROUTE-F-004  | P0       | Search shall match complete user-authored group and child labels without rewriting them.                                                           | Given mixed scripts, emoji, and long labels, when search matches, then the original label is rendered verbatim with a complete accessible name.                                       |
| ROUTE-F-005  | P0       | Latency tests shall be explicitly scoped and cancellable.                                                                                          | Given a group test is requested, then only the documented group/children are tested, progress is visible, previous results are timestamped, and cancellation stops new work.          |
| ROUTE-F-006  | P0       | Sorting shall distinguish configuration order, measured latency, and label order.                                                                  | Given stale or failed latency values, then latency sorting places them predictably and never treats failure as zero latency.                                                          |
| ROUTE-F-007  | P0       | Rule, Global, and Direct shall change routing mode without altering stored group selections.                                                       | Given group selections exist in Rule mode, when the user enters Direct and returns to Rule, then prior group selections remain unless the new profile changed them.                   |
| ROUTE-F-008  | P0       | Status shortcuts and Routes shall use the same group selector behavior.                                                                            | Given group G is changed from either surface, then the other surface reconciles to the same selected child.                                                                           |
| ROUTE-F-009  | P1       | The macOS status menu shall present `group -> child` for selectable groups.                                                                        | Given two groups select different children, when the status menu opens, then both selections are shown independently without a global active-node label.                              |
| ROUTE-F-010  | P0       | Group tools shall remain scoped to the expanded group.                                                                                             | Given filtering, sorting, detail visibility, or a latency test is changed for group G, then the UI identifies G and does not imply that unrelated groups or all proxies are affected. |
| ROUTE-NF-001 | P0       | Large profiles shall remain navigable.                                                                                                             | A fixture with the agreed maximum group/node counts meets search, expansion, and scrolling performance budgets without rendering every collapsed child.                               |

## Failure and boundary behavior

- Import never activates silently.
- A profile update may change or remove groups. The UI clears invalid open
  selections, preserves historical observations only under the same stable
  fingerprint policy, and explains removed targets.
- If the active profile becomes invalid after a core upgrade, capture does not
  continue under an unknown partial configuration. The last supported copy or a
  safe stopped state is used.
- Remote HTTP redirects, size, content type, and timeout are bounded. Private or
  loopback sources require an explicit trusted-local-source policy.
- Allow-invalid-certificate is an advanced exception, defaults off, explains
  the interception risk, and applies only to the named profile source.
- Unsupported configuration keys are preserved when safe but surfaced as
  warnings; the UI does not claim it can round-trip a file it rewrites unless
  that guarantee is tested.

## Metrics and validation

- Valid URL import to ready-to-activate summary completes in under the agreed
  network timeout and under two seconds after bytes are received for standard
  fixtures.
- Five representative users can identify the active profile and change a
  specific group's child without interpreting the child as global state.
- Transaction tests cover invalid update, core rejection, profile deletion,
  process crash during activation, and rollback.
- Secret fixtures pass screenshot, event, and diagnostic redaction tests.

## Dependencies

- Profile persistence, source fetcher, validator, stable fingerprinting, and
  activation transaction in the desktop bridge.
- Pinned Mihomo schemas for configuration, proxies, selection, and delay.
- Status group-usage retention policy.
- Secure local storage rules for source credentials.

## Open questions

1. Should P0 preserve arbitrary user YAML byte-for-byte, or store an immutable
   source plus a normalized runtime artifact?
2. Which authentication mechanisms for remote profiles are supported without
   creating an unsafe generic credential store?
3. Should profile organization support folders/tags in P1, or is search plus
   active/recent ordering sufficient?
4. When are local merge/transform capabilities valuable enough to justify their
   security and debugging cost?
