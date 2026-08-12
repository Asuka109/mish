# Mish Delivery Progress

Last updated: 2026-08-12 (Asia/Shanghai)
Owner: thread-master coordinator

## Current checkpoint

- Backlog preparation and Wave 1 were explicitly approved by the maintainer.
- The first seven Wave 1 workers used the wrong compute mapping and correctly
  stopped before changing files. Their task objects were permanently deleted
  and their seven clean worktrees were removed; they will not be resumed.
- Dispatch now uses a two-phase ledger: publish the complete manifest first,
  then create workers, then backfill task IDs and worktrees.
- The maintainer's project-specific Luna Max requirement explicitly overrode
  the thread-master default Codex compute table through Wave 2H. For Wave 2I,
  the maintainer explicitly selected `gpt-5.6-sol/high` for #435 H1.1. Chinese
  reporting remains required.
- AFK, confirmation-only work is scheduled before hands-on acceptance work.
- Maximum implementation concurrency is 10 workers, subject to dependency and
  integration-surface limits.

## Active tasks

Waves 2A through 2G are integrated. Wave 2G landed through PRs #494-#496 on
`origin/main@45842ccb`; coordinator review found no delivery defect and the
combined `pnpm check:pr` passed (Web 69 files / 603 tests and scripts 232
tests, plus Rust, simulated-host, Browser, production-exclusion,
documentation, and release gates). The maintainer approved the exact
three-task AFK Wave 2H on 2026-08-12. #449 C1.3 is integrated through PR #498
and Issue #449 is closed. #451 D1.3 is integrated through PR #497. #454 D2.1
merged PRs #499 and #500, but coordinator review found that the manifest's
synthetic signer pin is not wired to the certificate that actually signs the
built APK; the original Worker must resume for a second bounded follow-up.
Coordinator post-merge `pnpm check:pr` passed at `origin/main@176351ec` (Web 69
files / 613 tests, scripts 232 tests, Rust, simulated-host, Browser,
production-exclusion, documentation, and release gates). The maintainer
approved exact Wave 2I containing only independent #435 H1.1 and explicitly
selected `gpt-5.6-sol/high`; visible Worker
`019ff541-1dd8-7922-87f3-5a4e4f6894fd` is active in isolated worktree `c3da`.
Eight repository concurrency slots remain unreserved.

## Wave 1 worker ledger

| Task | Worker task ID | Worktree | State | Dependencies | Acceptance | Latest evidence / next action |
| --- | --- | --- | --- | --- | --- | --- |
| #436 A1.1 | `019fefb6-dbbc-7dd2-bd7c-2fcb7c10fdb4` | `39f5` | integrated | none | accepted | PR #460 merged as `3044867`; bounded kernel and repository gates passed, A1.2/A1.3 remain open. |
| #448 A2.1 | `019fefb6-df13-7c43-aa76-8baa63f77248` | `d79d` | integrated | none for A2.1 | accepted | PR #458 merged as `168292a`; exact-restore adapter gates passed, A2.2/A2.3 remain open. |
| #437 A3.1 | `019fefb6-dba8-7be2-9833-24c5c22f6c53` | `b68e` | integrated | none | accepted | PR #459 merged as `25ac46b`; bounded Internal TUN scenarios passed; A3.2 later completed the Issue. |
| #438 A4.1 | `019fefb6-db98-70d1-af16-de78daa9dc75` | `cb17` | integrated | none | accepted | PR #455 merged as `9322e17`; local/remote gates passed; A4.2 later completed the Issue. |
| #439 A5.1 | `019fefb6-dbaf-7681-9870-208086d1043d` | `e87b` | integrated | none | accepted | PR #461 merged as `5b454ea`; identity-bound process gates passed; A5.2 later completed Issue #439. |
| #440 B1.1 | `019fefb6-db98-70d1-af16-de5e1c0c457e` | `3ab4` | integrated | none | accepted | PR #457 merged as `8c23789`; local/remote gates passed; B1.2/B1.3 later integrated and B1.4/B1.5 remain open. |
| #443 E2.1 | `019fefb6-dbbd-78a1-b4d1-4cca4ae1099b` | `2d87` | integrated | none | accepted | PR #456 merged as `f27a711a`; Fast PR gate passed; E2.2 later integrated and E2.3 remains open. |

## Wave 2A dispatch manifest

All entries use model `gpt-5.6-luna`, reasoning effort `max`, Chinese reporting,
confirmation-only acceptance, and final-only parent escalation. This wave is
AFK and authorizes no real-host mutation or hands-on acceptance.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Latest evidence / next action |
| --- | --- | --- | --- | --- | --- | --- |
| #440 B1.2 | `019feff9-1bf6-74f2-9055-1bd917be13e9` | `922f` | integrated | B1.1 integrated | One RPC Session Authority for baselines, generations, stale rejection, and deterministic tests | PR #462 merged as `80e23d0`; Fast PR gate, RPC 22 tests, and Web 574 tests passed; B1.3 later integrated and B1.4/B1.5 remain open. |
| #436 A1.2 | `019feff9-1bf6-74f2-9055-1bc6e48395e4` | `a993` | integrated | A1.1 integrated | Migrate Capture shutdown/cancellation to the shared runtime with cleanup, panic, and replacement transcripts | PR #467 merged as `99b1928`; Fast PR and Android gates passed; coordinator combined `pnpm check:pr` passed; A1.3 remains open. |
| #437 A3.2 | `019feff9-1f57-7b23-885f-7c0cb609aee8` | `f803` | integrated | A3.1 integrated | Complete Internal TUN fault matrix, schema/privacy checks, and RPC/React journeys | PR #464 merged as `f15d6db`; coordinator SimulatedHost 12+24+2+10, Browser 9/9, and exclusion 10/10 passed; Issue #437 closed completed. |
| #438 A4.2 | `019feff9-1bf6-74f2-9055-1bb47d5ff79c` | `290d` | integrated | A4.1 integrated | Add only missing Browser fixture production-exclusion enforcement and residual behavior coverage | PR #465 merged as `7c66f43`; Fast PR gate and coordinator exclusion 10/10, mobile 4/4, Browser 12/12 checks passed; Issue #438 closed completed. |
| #443 E2.2 | `019feff9-1bf2-7621-a5b9-dd08b6240627` | `8407` | integrated | E2.1 integrated | Enforce relevant target compile, Clippy, and test coverage for platform crates | PR #466 merged as `74c23dd`; Fast PR and Android gates passed; coordinator policy 6/6 plus macOS target compile/Clippy and 162 tests passed; E2.3 remains open. |
| #441 C2.1 | `019feff9-1bf9-7943-9ed1-399bb2b16b31` | `3d15` | integrated | none | Private durable staging and atomic Profile generation publication | PR #463 merged as `76cbf1d`; Fast PR gate and coordinator Profile 8 + 26 + 19 tests passed; C2.2/C2.3 remain open. |
| #442 E1.1 | `019feff9-1bf4-7283-9330-1117529fce86` | `40ee` | integrated | none | Release executable/path containment under private no-follow roots | PR #468 merged as `443e0a5`; Fast PR gate and coordinator bundle 34/34, release 9/9, signed-release 10/10, updater 74/74 passed; E1.4 must cover concurrent overwrite/assert-use replacement. |

## Planned issue graph

| Theme | Issue | State | Blocked by | Acceptance |
| --- | --- | --- | --- | --- |
| Owned operations | #436 | completed: A1.1-A1.3 integrated; Issue closed | none | accepted |
| System Proxy restoration | #448 | A2.1/A2.2 integrated; A2.3 planned | #436 A1.1 for A2.2 | A2.1/A2.2 confirmation-only; A2.3 hands-on |
| SimulatedHost truthfulness | #437 | completed: A3.1/A3.2 integrated; Issue closed | none | accepted |
| Browser fixture truthfulness | #438 | completed: A4.1/A4.2 integrated; Issue closed | none | accepted |
| Process identity | #439 | completed: A5.1/A5.2 integrated; Issue closed | none | accepted |
| RPC Session Authority | #440 | completed: B1.1-B1.5 integrated; Issue closed | none | accepted |
| Profile credential privacy | #449 | completed: C1.1-C1.3 integrated; Issue closed | #440 completed | accepted |
| Atomic profile generations | #441 | completed: C2.1-C2.3 integrated; Issue closed | none | accepted |
| Backup preview authority | #450 | completed: C3.1/C3.2 integrated; Issue closed | #440 completed | accepted |
| Android VPN authority | #451 | D1.1-D1.3 integrated; D1.4 blocked on operational D2.1 signer/build closure | #440 and #436 completed | confirmation-only; physical residual stays in #268 |
| Mobile Core provenance | #454 | D2.1 second build-signer follow-up active; D2.2/D2.3 sequential afterward | #451 D1.2 integrated | confirmation-only |
| System-component repair feedback | #435 | H1.1 automated vertical repair ready; H1.2 hands-on residual later | none; preserve existing Helper/Capture authority | H1.1 confirmation-only; H1.2 hands-on |
| Release trust boundary | #442 | completed: E1.1-E1.4 integrated; Issue closed | none | accepted; real signing stays in #173 |
| CI policy coverage | #443 | completed: E2.1-E2.3 integrated; Issue closed | none | accepted |
| Settings editor serialization | #452 | completed: F1.1/F1.2 integrated; Issue closed | #440 completed | accepted |
| Remove Profile Patch Editor | #453 | completed: F2.1-F2.3 integrated; Issue closed | #440 completed | accepted |
| Lazy-route recovery | #444 | completed: G1.1 integrated; Issue closed | none | accepted |
| Traffic details accessibility | #445 | completed: G2.1 integrated; Issue closed | none | accepted |
| Clipboard failure feedback | #446 | completed: G3.1 integrated; Issue closed | none | accepted |
| Muted-text contrast | #447 | completed: G4.1 integrated; Issue closed | none | accepted |

## Wave 2B dispatch manifest

The maintainer approved this exact AFK wave. Every entry uses model
`gpt-5.6-luna`, reasoning effort `max`, Chinese reporting, confirmation-only
acceptance, final-only parent escalation, and an isolated worktree. The wave
authorizes no real-host mutation, Tart run, signing, release publication,
branch-protection mutation, or other hands-on acceptance.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Integration boundary |
| --- | --- | --- | --- | --- | --- | --- |
| #436 A1.3 | `019ff06b-345d-7993-a0ac-3303ad0919cb` | `5e41` | integrated | A1.1/A1.2 integrated | Register and document the single owned-operation lifecycle authority and enforce it statically | PR #471 merged as `abb82c1`; final local/remote gates passed, all acceptance criteria were checked, and Issue #436 closed without claiming #353 physical acceptance |
| #448 A2.2 | `019ff06b-2dbe-7653-abf7-03eed0131628` | `7719` | integrated | A1.1 and A2.1 integrated | Record the exact System Proxy invocation/result matrix and replay it through SimulatedHost | PR #474 merged as `2c1d89d`; local final `pnpm check:pr`, Fast PR, and Android gates passed; no Tart or developer-host mutation and A2.3 remains hands-on |
| #439 A5.2 | `019ff06b-2dc1-7f93-9a65-b7ce552e2ab2` | `c3b7` | integrated | A5.1 integrated | Migrate activation/recovery to identity-bound process control and add PID reuse/replacement/timeout transcripts | PR #475 merged as `dc80bf4`; final `pnpm check:pr`, Fast PR, and Android gates passed after preserving A2.2 overlap; Issue #439 closed, while #353 remains independent |
| #440 B1.3 | `019ff06b-2dbc-7af2-ad28-80f04ef51b7d` | `46eb` | integrated | B1.2 integrated | Migrate Status, Traffic, and Updater consumers to `RpcSessionAuthority` | PR #470 merged as `bbcd699`; acceptance follow-up PR #476 merged as `7cec8f9`; Status 17/17 plus full local/remote gates passed; B1.4/B1.5 remain open |
| #441 C2.2 | `019ff06b-2dbe-7653-abf7-03be5ddcf3e8` | `d144` | integrated | C2.1 integrated | Make reconciliation, selection, detach, and activation read only complete Profile generations | PR #472 merged as `ef7380e`; Profile 8/27/20, activation 52 passed/3 ignored, full local/remote gates passed; C2.3 remains open |
| #442 E1.2 | `019ff06b-2dc0-7350-906c-4b8b771619c6` | `0996` | integrated | E1.1 integrated | Verify attestation signature, predicate, repository/workflow identity, commit SHA, and artifact digest | PR #473 merged as `c9fa882`; Fast PR and Android gates plus post-merge `pnpm check:pr` passed; E1.3/E1.4 remain open and no real credentials or release mutation were used |
| #443 E2.3 | `019ff06b-2dc0-7350-906c-4baafbeecbe7` | `0746` | integrated | E2.1/E2.2 integrated | Add workflow/target drift fixtures, evidence-boundary documentation, and read-only branch-protection checks | PR #469 merged as `4bb72f6`; local policy/docs gates and remote CI passed, all criteria were checked, and Issue #443 closed without external setting mutation |

## Wave 2C dispatch manifest

The maintainer approved this exact seven-task AFK wave. Every entry uses model
`gpt-5.6-luna`, reasoning effort `max`, Chinese reporting, confirmation-only
acceptance, final-only parent escalation, and an isolated worktree. The wave
authorizes no real credentials, signing, notarization, release publication,
physical-host mutation, device/emulator acceptance, or other hands-on work.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Integration boundary |
| --- | --- | --- | --- | --- | --- | --- |
| #440 B1.4 | `019ff0db-3399-7e42-a8d6-ceb53d386a95` | `a427` | integrated | B1.3 integrated | Migrate Profile, Settings, Notifications, and providers to `RpcSessionAuthority` | PR #483 merged as `c5201a5`; focused 153 tests, final `check:pr`, Fast PR, and Android gates passed; B1.5 remains open |
| #441 C2.3 | `019ff0db-c089-79a3-a4c8-3f6fb925a924` | `069d` | integrated | C2.2 integrated | Add filesystem adversarial, crash, restart, and transcript coverage for atomic Profile generations | PR #481 merged as `2f367df`; local/remote gates passed with synthetic/private fixtures; Issue #441 closed completed |
| #442 E1.3 | `019ff0db-c092-74c3-bd39-69046c098ff1` | `a78d` | integrated | E1.2 integrated | Implement the secret-safe bounded signing/notarization runner and cleanup contract | PR #480 merged as `a85ce61`; credential-free local/remote gates passed; E1.4 remains open |
| #444 G1.1 | `019ff0db-c163-75b2-a02b-e6edba89bf2c` | `03e1` | integrated | none | Add localized lazy-route/render failure recovery, bounded retry, and focused tests | PR #482 merged as `62e01ef`; local/remote gates passed; Issue #444 closed completed |
| #445 G2.1 | `019ff0db-c21e-71a3-9724-6f62073197bd` | `ff1b` | integrated | none | Expose Traffic row details through an accessible action with keyboard/focus tests | PR #478 merged as `9da5aec`; local/remote gates passed; Issue #445 closed completed |
| #446 G3.1 | `019ff0db-c350-78f3-9a38-e9a1c1694fcf` | `2974` | integrated | none | Report clipboard rejection through accessible non-blocking Events feedback | PR #479 merged as `1a41f4f`; local/remote gates passed; Issue #446 closed completed |
| #447 G4.1 | `019ff0db-c366-7830-9cd0-d1797504f6b5` | `b600` | integrated | none | Repair muted normal-text contrast at the narrowest token/usage owner with computed tests | PR #477 merged as `f863b19`; computed contrast and local/remote gates passed; Issue #447 closed completed |

## Wave 2D dispatch manifest

The maintainer approved this exact two-task AFK wave. Both entries use model
`gpt-5.6-luna`, reasoning effort `max`, Chinese reporting, confirmation-only
acceptance, final-only parent escalation, and an isolated worktree. The wave
authorizes no real credentials, signing, notarization, release publication,
physical-host mutation, or other hands-on work.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Integration boundary |
| --- | --- | --- | --- | --- | --- | --- |
| #440 B1.5 | `019ff17f-35cb-7103-9517-2e1923f0f695` | `c5a6` | integrated | B1.1-B1.4 integrated | Delete duplicate sequencing logic and finish the RPC Session Authority contract documentation and static gates | PR #485 merged as `d64df01`; local final `check:pr`, Android gate, and all Fast PR job steps passed, while the GitHub run envelope remains stale `in_progress`; Issue #440 closed completed |
| #442 E1.4 | `019ff17f-35cd-7602-a70d-c61f73117922` | `393d` | integrated | E1.1-E1.3 integrated | Add the credential-free adversarial matrix and complete fail-closed release gate | PR #484 merged as `949b4fd`; release security, final `check:pr`, Fast PR, and Android gates passed without credentials or real signing; Issue #442 closed completed |

## Wave 2E dispatch manifest

The maintainer approved this exact five-task AFK wave. Every entry uses model
`gpt-5.6-luna`, reasoning effort `max`, Chinese reporting, confirmation-only
acceptance, final-only parent escalation, and an isolated worktree. The wave
authorizes no credentials, physical-device acceptance, real-host mutation, or
other hands-on work.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Integration boundary |
| --- | --- | --- | --- | --- | --- | --- |
| #449 C1.1 | `019ff1b0-737c-7ed0-9392-1f8746301eed` | `431d` | integrated | #440 completed | Introduce the redacted subscription summary DTO and structured-event redaction contract | PR #488 merged as `1ab9421`; local/remote gates passed; Issue #449 remains open with only C1.1 checked |
| #450 C3.1 | `019ff1b0-737c-7ed0-9392-1fb8dc1725fa` | `c27c` | integrated | #440 completed | Add the scope/preview/session-generation fingerprint contract | PR #489 merged as `d609179`; local/remote gates passed; Issue #450 remains open with only C3.1 checked |
| #451 D1.1 | `019ff1b0-737d-7651-badf-08f9bc0eed79` | `ecd5` | integrated | #436 and #440 completed | Harden Rust Android VPN replacement, cleanup barriers, and the `Stopped` invariant | PR #490 merged as `71eab13d`; Fast PR and Android gates plus coordinator combined `check:pr` passed; Issue #451 remains open with only D1.1 checked |
| #452 F1.1 | `019ff1b0-737c-7ed0-9392-1f373f75ee5a` | `b3af` | integrated | #440 completed | Implement one editor operation identity and unified pending exclusion policy | PR #486 merged as `39c279f`; local/remote gates passed; Issue #452 remains open with only F1.1 checked |
| #453 F2.1 | `019ff1b0-737c-7ed0-9392-1f5e14e25def` | `fded` | integrated | #440 completed | Produce a read-only reachability trace and exact Profile Patch Editor deletion manifest | PR #487 merged as `911ac9f`; the trace found no supported runtime entry and authorizes exact-manifest deletion in F2.2; Issue #453 remains open with only F2.1 checked |

## Wave 2F dispatch manifest

The maintainer approved this exact three-task AFK wave. Every entry uses model
`gpt-5.6-luna`, reasoning effort `max`, Chinese reporting, confirmation-only
acceptance, final-only parent escalation, and an isolated worktree. Workers
must read both progress ledgers and follow the transcript-driven system-test
skill for boundary, fixture, bridge, or simulated-host changes. This wave
authorizes no credentials, physical-device acceptance, real-host mutation, or
other hands-on work.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Integration boundary |
| --- | --- | --- | --- | --- | --- | --- |
| #450 C3.2 | `019ff1fe-e059-7f10-af58-d536cb062052` | `c4a5` | integrated | C3.1 integrated | Implement Browser Mode deferred, replacement, and stale-preview behavior plus save-blocking tests | PR #491 merged as `ea85343f`; combined local/remote gates passed; all acceptance criteria were checked and Issue #450 closed completed |
| #452 F1.2 | `019ff1fe-e059-7f10-af58-d559eb52bc37` | `e791` | integrated | F1.1 integrated | Implement Restore Defaults confirmation/cancellation behavior and failure/late-completion tests | PR #492 merged as `c84072d`; coordinator corrected the stale F1.2/acceptance checkboxes after combined gates passed and closed Issue #452 completed |
| #453 F2.2 | `019ff1fe-e059-7f10-af58-d574154512c1` | `ecac` | integrated | F2.1 integrated | Delete the dead Profile Patch Editor path and exact dependent contracts, styles, tests, and generated artifacts | PR #493 merged as `e475a22f`; generated contracts, active Profile/patch-engine paths, production exclusions, and combined `check:pr` passed; F2.3 remains open |

## Wave 2G dispatch manifest

The maintainer approved this exact three-task AFK wave and explicitly retained
the repository-specific compute override. Every entry uses model
`gpt-5.6-luna`, reasoning effort `max`, Chinese reporting, confirmation-only
acceptance, final-only parent escalation, and an isolated worktree. Workers
must read both progress ledgers and follow the transcript-driven system-test
skill for boundary, fixture, bridge, native, or simulated-host changes. This
wave authorizes no credentials, physical-device acceptance, real-host mutation,
or other hands-on work.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Integration boundary |
| --- | --- | --- | --- | --- | --- | --- |
| #449 C1.2 | `019ff22f-8c1c-7d71-8862-69aa7000dff8` | `aa93` | integrated | C1.1 and F2.2 integrated | Bind HTTPS import requests to the current accepted generation and reject stale previews/requests | PR #495 merged as `9596812f`; latest-main integration and full local/remote gates passed; Issue #449 remains open with C1.3 pending |
| #451 D1.2 | `019ff22f-8c1c-7d71-8862-69c06b43c5a0` | `2a8b` | integrated | D1.1 integrated | Harden Kotlin authority acquisition before effects and retain retryable cleanup state after failure | PR #496 merged as `45842ccb`; local mobile/full gates and remote Fast/Android gates passed; Issue #451 remains open with D1.3/D1.4 pending |
| #453 F2.3 | `019ff22f-8c1c-7d71-8862-69e066d54506` | `9b1e` | integrated | F2.2 integrated | Add route/static regression coverage and run the active Profile edit/save/discard journey | PR #494 merged as `c54e5345`; removal gate 9/9, Profile journey 7/7, and full local/remote gates passed; Issue #453 closed completed |

## Wave 2H dispatch manifest

The maintainer approved this exact three-task AFK wave. Every entry uses model
`gpt-5.6-luna`, reasoning effort `max`, Chinese reporting, confirmation-only
acceptance, final-only parent escalation, and an isolated worktree. Workers
must read both progress ledgers. Boundary/native/lifecycle work must follow the
transcript-driven system-test skill, retain real product authorities, record
bounded invocation/results, add deterministic use cases, prove structural
privacy and production exclusion, and state what simulated evidence cannot
prove. This wave authorizes no credentials, external-network dependency,
emulator/physical-device acceptance, real-host mutation, or other hands-on
work.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Integration boundary |
| --- | --- | --- | --- | --- | --- | --- |
| #449 C1.3 | `019ff3ec-8c5f-7321-80ce-81a078164789` | `2bd3` | integrated | C1.1/C1.2 integrated | Require explicit credential-free detach confirmation and prove subscription tokens are absent from snapshots, logs, events, and rendered UI | PR #498 merged as `5239df6f`; local/remote gates passed, all Issue #449 criteria read back checked, and Issue closed completed without real credentials/network claims |
| #451 D1.3 | `019ff3ec-8c5f-7321-80ce-81e61066291c` | `603d` | integrated | D1.1/D1.2 integrated | Migrate JavaScript mobile VPN baselines, stale-snapshot rejection, abort/dispose, and stale-load handling without creating another lifecycle owner | PR #497 merged as `176351ec`; focused/full local gates and remote Fast PR/Android gates passed; Issue #451 remains open with D1.4 pending and no device claim |
| #454 D2.1 | `019ff3ec-8c5f-7321-80ce-81c68e466c9f` | `37eb` | active; second review follow-up | #451 D1.2 integrated | Admit Mobile Core only when exact source/version, wrapper contract, ABI, digest, and signature satisfy a pinned fail-closed native policy before effects | PRs #499 / `32ac48ba` and #500 / `817a933e` merged, but the synthetic manifest fingerprint is not the signer of the produced APK and CI only verifies signature presence; the same Worker must close build signer -> manifest pin -> PackageManager observation or report a precise credential-free blocker; D2.2/D2.3 remain untouched |

## Wave 2I dispatch manifest

The maintainer approved this exact one-task AFK wave and explicitly selected
model `gpt-5.6-sol`, reasoning effort `high`, Chinese reporting,
confirmation-only acceptance, final-only parent escalation, and an isolated
worktree. The Worker must read both progress ledgers and follow the
transcript-driven system-test skill. This wave authorizes no real administrator
prompt, Helper/Core installation, system-component mutation, credentials,
physical-host acceptance, or other hands-on work.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Integration boundary |
| --- | --- | --- | --- | --- | --- | --- |
| #435 H1.1 | `019ff541-1dd8-7922-87f3-5a4e4f6894fd` | `c3da` | active | none; preserve existing Helper/Capture authority | Correlate Repair/Remove/retry under one operation identity, settle modal and notification feedback exactly once, correct action copy, and add bounded invocation/result transcripts plus deterministic Rust/RPC/React journeys | Automated/synthetic only: do not repair the underlying Helper installation failure, invoke a real administrator prompt, or claim actual host mutation; H1.2 retains hands-on authorization and Remove-mutation validation |

## Existing issue coordination

| Issue | State | Coordination rule |
| --- | --- | --- |
| #353 | needs-input | Preserve the existing visible worker; do not silently replace it. Relevant #436/#448/#439 automated evidence is integrated; any resume remains an explicit hands-on physical-host action. |
| #352 | needs-info | Wait for recurrence; use #437's corrected harness to retain evidence. |
| #435 | ready-for-agent | Wave 2I H1.1 dispatching under one visible Worker; H1.2 hands-on acceptance remains last. Do not duplicate. |
| #265/#266/#268/#281/#283/#284 | blocked | Their Issue bodies now record #451/#454 as architecture dependencies; #265 also records #441. |
| #173/#174/#274 | planned dependencies | #442 supplies security prerequisites without replacing their release/signing acceptance. |

## Wave 1 — approved for dispatch

| Task | Intended result | Model | Dependencies | Readiness |
| --- | --- | --- | --- | --- |
| #436 A1.1 | Bounded forced-retirement/finalizer/shutdown kernel | `gpt-5.6-luna/max` | none | integrated (`3044867`) |
| #448 A2.1 | Exact System Proxy restore adapter | `gpt-5.6-luna/max` | none for A2.1 | integrated (`168292a`) |
| #437 A3.1 | Truthful effect ordering, ownership, and bounded faults | `gpt-5.6-luna/max` | none | integrated (`25ac46b`) |
| #438 A4.1 | Typed unsupported/simulated browser Capture behavior | `gpt-5.6-luna/max` | none | integrated (`9322e17`) |
| #439 A5.1 | Identity-bound Core termination and probes | `gpt-5.6-luna/max` | none | integrated (`5b454ea`) |
| #440 B1.1 | Bounded RPC transport IDs, deadlines, and envelopes | `gpt-5.6-luna/max` | none | integrated (`8c23789`) |
| #443 E2.1 | Complete workflow/job policy parsing | `gpt-5.6-luna/max` | none | integrated (`f27a711a`) |

The Wave 1 tasks were AFK and confirmation-only. All seven are integrated. Each
worker used an isolated worktree, one linked Issue/task, Chinese reporting,
final-only escalation, and explicit human acceptance before merge.

## Later-wave gates

- The exact approved Wave 2H is #449 C1.3, #451 D1.3, and #454 D2.1. #449 C1.3
  and #451 D1.3 are integrated; #454 D2.1 remains active in its original AFK,
  confirmation-only, Chinese-reporting Luna Max (`gpt-5.6-luna/max`) visible
  task and isolated worktree.
- #449 C1.3 is independent of the mobile tasks and completes detach
  confirmation plus credential-token negative evidence without real
  credentials or external network access.
- #451 D1.3 completed the Web/JavaScript mobile lifecycle authority,
  abort/dispose, baseline, and stale-load surface. #454 D2.1 owns only
  Kotlin/native pinned Mobile Core artifact admission. Its second follow-up
  must establish that the actual credential-free debug APK build signer, the
  source-manifest pin, CI package verification, and PackageManager observation
  are the same identity. If that cannot be done without committing sensitive
  material or weakening release boundaries, the Worker must stop with a
  precise design blocker. It may not implement D1.4, D2.2, D2.3, or claim
  emulator/device or release-signing acceptance.
- #442 is complete. Its credential-free security prerequisite does not replace
  the real signing and release acceptance retained in #173, #174, and #274.
- Complete #454 D2.1 before D2.2, D2.3, or #451 D1.4.
- Approved Wave 2I contains one independent AFK task: #435 H1.1. It will
  preserve the Rust/Helper/Capture lifecycle as the only product authority,
  correlate Repair/Remove/retry under one operation identity, settle modal and
  notification feedback exactly once, correct action copy, and add bounded
  invocation/result transcripts plus deterministic Rust/RPC/React journeys.
  It must not repair the underlying Helper installation failure or invoke a
  real administrator prompt. The later H1.2 hands-on residual will validate
  authorization and actual Remove mutation in a disposable target.
- #435 H1.1 is independent of the Android Wave 2H files and may run while the
  D2.1 follow-up finishes. The maintainer explicitly overrode the earlier Luna
  Max project setting for this task and selected `gpt-5.6-sol/high`, Chinese
  reporting, confirmation-only acceptance, final-only escalation, and an
  isolated worktree. Visible Worker `019ff541-1dd8-7922-87f3-5a4e4f6894fd`
  is active in worktree `c3da`.
- Keep #448 A2.3, #353 physical-host work, #435 hands-on repair validation,
  #173 real signing, #268 physical-device acceptance, and other human checks
  behind AFK implementation and automated evidence.
- Before any later wave containing a hands-on task is proposed or dispatched,
  explicitly warn the maintainer that the wave requires human acceptance and
  identify the exact residual walkthrough.

## Update protocol

Before worker creation, publish every exact task as `dispatching` with pending
identity fields. After creation, backfill worker task ID, branch/worktree,
lifecycle state, dependencies, latest concrete evidence, acceptance style, PR,
tracker state, and next action. Move completed work through accepted, merged,
and integrated separately; passing CI alone is not acceptance.
