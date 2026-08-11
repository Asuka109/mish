# Mish Delivery Progress

Last updated: 2026-08-11 (Asia/Shanghai)
Owner: thread-master coordinator

## Current checkpoint

- Backlog preparation and Wave 1 were explicitly approved by the maintainer.
- The first seven Wave 1 workers used the wrong compute mapping and correctly
  stopped before changing files. Their task objects were permanently deleted
  and their seven clean worktrees were removed; they will not be resumed.
- Dispatch now uses a two-phase ledger: publish the complete manifest first,
  then create workers, then backfill task IDs and worktrees.
- All planned workers must use Luna Max: `gpt-5.6-luna` with reasoning effort
  `max`, reporting in Chinese.
- AFK, confirmation-only work is scheduled before hands-on acceptance work.
- Maximum implementation concurrency is 10 workers, subject to dependency and
  integration-surface limits.

## Active tasks

Wave 2A is fully integrated. The maintainer approved the exact seven-task Wave
2B on 2026-08-11. All seven Luna Max Workers were created from the published
manifest baseline `4df0ebe`; their identities and isolated worktrees are
backfilled below. Four Workers are active, including #439 A5.2 refreshing onto
the latest main after its second green CI run; #436 A1.3 is merged with final
handoff pending, #448 A2.2 is merged with its
post-merge Fast PR gate passed and is integrated, #442 E1.2 is integrated, no
dispatch reservation remains, and five concurrency slots are unreserved. #440 B1.3 merged in PR #470,
but coordinator acceptance review found that Status error reconciliation can
expose an equal-order conflicting snapshot outside `RpcSessionAuthority`; the
original Worker owns the bounded follow-up before B1.3 is integrated.

## Wave 1 worker ledger

| Task | Worker task ID | Worktree | State | Dependencies | Acceptance | Latest evidence / next action |
| --- | --- | --- | --- | --- | --- | --- |
| #436 A1.1 | `019fefb6-dbbc-7dd2-bd7c-2fcb7c10fdb4` | `39f5` | integrated | none | accepted | PR #460 merged as `3044867`; bounded kernel and repository gates passed, A1.2/A1.3 remain open. |
| #448 A2.1 | `019fefb6-df13-7c43-aa76-8baa63f77248` | `d79d` | integrated | none for A2.1 | accepted | PR #458 merged as `168292a`; exact-restore adapter gates passed, A2.2/A2.3 remain open. |
| #437 A3.1 | `019fefb6-dba8-7be2-9833-24c5c22f6c53` | `b68e` | integrated | none | accepted | PR #459 merged as `25ac46b`; bounded Internal TUN scenarios passed; A3.2 later completed the Issue. |
| #438 A4.1 | `019fefb6-db98-70d1-af16-de78daa9dc75` | `cb17` | integrated | none | accepted | PR #455 merged as `9322e17`; local/remote gates passed; A4.2 later completed the Issue. |
| #439 A5.1 | `019fefb6-dbaf-7681-9870-208086d1043d` | `e87b` | integrated | none | accepted | PR #461 merged as `5b454ea`; identity-bound process gates passed, Issue checklist synced, A5.2 remains open. |
| #440 B1.1 | `019fefb6-db98-70d1-af16-de5e1c0c457e` | `3ab4` | integrated | none | accepted | PR #457 merged as `8c23789`; local/remote gates passed, Issue checklist synced, B1.2-B1.5 remain open. |
| #443 E2.1 | `019fefb6-dbbd-78a1-b4d1-4cca4ae1099b` | `2d87` | integrated | none | accepted | PR #456 merged as `f27a711a`; Fast PR gate passed; E2.2 later integrated and E2.3 remains open. |

## Wave 2A dispatch manifest

All entries use model `gpt-5.6-luna`, reasoning effort `max`, Chinese reporting,
confirmation-only acceptance, and final-only parent escalation. This wave is
AFK and authorizes no real-host mutation or hands-on acceptance.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Latest evidence / next action |
| --- | --- | --- | --- | --- | --- | --- |
| #440 B1.2 | `019feff9-1bf6-74f2-9055-1bd917be13e9` | `922f` | integrated | B1.1 integrated | One RPC Session Authority for baselines, generations, stale rejection, and deterministic tests | PR #462 merged as `80e23d0`; Fast PR gate, RPC 22 tests, and Web 574 tests passed; only Events migrated, B1.3-B1.5 remain open. |
| #436 A1.2 | `019feff9-1bf6-74f2-9055-1bc6e48395e4` | `a993` | integrated | A1.1 integrated | Migrate Capture shutdown/cancellation to the shared runtime with cleanup, panic, and replacement transcripts | PR #467 merged as `99b1928`; Fast PR and Android gates passed; coordinator combined `pnpm check:pr` passed; A1.3 remains open. |
| #437 A3.2 | `019feff9-1f57-7b23-885f-7c0cb609aee8` | `f803` | integrated | A3.1 integrated | Complete Internal TUN fault matrix, schema/privacy checks, and RPC/React journeys | PR #464 merged as `f15d6db`; coordinator SimulatedHost 12+24+2+10, Browser 9/9, and exclusion 10/10 passed; Issue #437 closed completed. |
| #438 A4.2 | `019feff9-1bf6-74f2-9055-1bb47d5ff79c` | `290d` | integrated | A4.1 integrated | Add only missing Browser fixture production-exclusion enforcement and residual behavior coverage | PR #465 merged as `7c66f43`; Fast PR gate and coordinator exclusion 10/10, mobile 4/4, Browser 12/12 checks passed; Issue #438 closed completed. |
| #443 E2.2 | `019feff9-1bf2-7621-a5b9-dd08b6240627` | `8407` | integrated | E2.1 integrated | Enforce relevant target compile, Clippy, and test coverage for platform crates | PR #466 merged as `74c23dd`; Fast PR and Android gates passed; coordinator policy 6/6 plus macOS target compile/Clippy and 162 tests passed; E2.3 remains open. |
| #441 C2.1 | `019feff9-1bf9-7943-9ed1-399bb2b16b31` | `3d15` | integrated | none | Private durable staging and atomic Profile generation publication | PR #463 merged as `76cbf1d`; Fast PR gate and coordinator Profile 8 + 26 + 19 tests passed; C2.2/C2.3 remain open. |
| #442 E1.1 | `019feff9-1bf4-7283-9330-1117529fce86` | `40ee` | integrated | none | Release executable/path containment under private no-follow roots | PR #468 merged as `443e0a5`; Fast PR gate and coordinator bundle 34/34, release 9/9, signed-release 10/10, updater 74/74 passed; E1.4 must cover concurrent overwrite/assert-use replacement. |

## Planned issue graph

| Theme | Issue | State | Blocked by | Acceptance |
| --- | --- | --- | --- | --- |
| Owned operations | #436 | A1.1/A1.2 integrated; A1.3 merged with final handoff pending | none | confirmation-only |
| System Proxy restoration | #448 | A2.1/A2.2 integrated; A2.3 planned | #436 A1.1 for A2.2 | A2.1/A2.2 confirmation-only; A2.3 hands-on |
| SimulatedHost truthfulness | #437 | completed: A3.1/A3.2 integrated; Issue closed | none | accepted |
| Browser fixture truthfulness | #438 | completed: A4.1/A4.2 integrated; Issue closed | none | accepted |
| Process identity | #439 | A5.1 integrated; A5.2 delivered in PR #475, refreshing latest main before acceptance | none | confirmation-only |
| RPC Session Authority | #440 | B1.1/B1.2 integrated; B1.3 merged with bounded acceptance rework; B1.4/B1.5 planned | none | confirmation-only |
| Profile credential privacy | #449 | ready; not dispatched | #440 B1.2 integrated | confirmation-only |
| Atomic profile generations | #441 | C2.1 integrated; C2.2/C2.3 planned | none | confirmation-only |
| Backup preview authority | #450 | ready; not dispatched | #440 B1.2 integrated | confirmation-only |
| Android VPN authority | #451 | blocked | #436, #440 | confirmation-only; physical residual stays in #268 |
| Mobile Core provenance | #454 | blocked | #451 | confirmation-only |
| Release trust boundary | #442 | E1.1/E1.2 integrated; E1.3/E1.4 planned | none | confirmation-only; real signing stays in #173 |
| CI policy coverage | #443 | E2.1/E2.2 integrated; E2.3 planned | none | confirmation-only |
| Settings editor serialization | #452 | ready; not dispatched | #440 B1.2 integrated | confirmation-only |
| Remove Profile Patch Editor | #453 | ready; not dispatched | #440 B1.2 integrated | confirmation-only |
| Lazy-route recovery | #444 | planned | none | confirmation-only |
| Traffic details accessibility | #445 | planned | none | confirmation-only |
| Clipboard failure feedback | #446 | planned | none | confirmation-only |
| Muted-text contrast | #447 | planned | none | confirmation-only |

## Wave 2B dispatch manifest

The maintainer approved this exact AFK wave. Every entry uses model
`gpt-5.6-luna`, reasoning effort `max`, Chinese reporting, confirmation-only
acceptance, final-only parent escalation, and an isolated worktree. The wave
authorizes no real-host mutation, Tart run, signing, release publication,
branch-protection mutation, or other hands-on acceptance.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Integration boundary |
| --- | --- | --- | --- | --- | --- | --- |
| #436 A1.3 | `019ff06b-345d-7993-a0ac-3303ad0919cb` | `5e41` | merged; handoff pending | A1.1/A1.2 integrated | Register and document the single owned-operation lifecycle authority and enforce it statically | PR #471 merged as `abb82c1`; await the Worker's final evidence/tracker handoff before integration; do not infer Issue completion from the merge alone |
| #448 A2.2 | `019ff06b-2dbe-7653-abf7-03eed0131628` | `7719` | integrated | A1.1 and A2.1 integrated | Record the exact System Proxy invocation/result matrix and replay it through SimulatedHost | PR #474 merged as `2c1d89d`; local final `pnpm check:pr`, Fast PR, and Android gates passed; no Tart or developer-host mutation and A2.3 remains hands-on |
| #439 A5.2 | `019ff06b-2dc1-7f93-9a65-b7ce552e2ab2` | `c3b7` | active | A5.1 integrated | Migrate activation/recovery to identity-bound process control and add PID reuse/replacement/timeout transcripts | PR #475 passed Fast PR and Android gates after preserving A2.2 overlap; merge latest `origin/main@abb82c1`, rerun gates, then request maintainer confirmation; preserve #353 |
| #440 B1.3 | `019ff06b-2dbc-7af2-ad28-80f04ef51b7d` | `46eb` | rework | B1.2 integrated | Migrate Status, Traffic, and Updater consumers to `RpcSessionAuthority` | PR #470 merged as `bbcd699`; reject or authority-project conflicting Status error reconciliation snapshots, add the missing deterministic regression, and do not touch B1.4/B1.5 |
| #441 C2.2 | `019ff06b-2dbe-7653-abf7-03be5ddcf3e8` | `d144` | active | C2.1 integrated | Make reconciliation, selection, detach, and activation read only complete Profile generations | C2.3 adversarial/crash/restart matrix remains separate; follow the transcript skill |
| #442 E1.2 | `019ff06b-2dc0-7350-906c-4b8b771619c6` | `0996` | integrated | E1.1 integrated | Verify attestation signature, predicate, repository/workflow identity, commit SHA, and artifact digest | PR #473 merged as `c9fa882`; Fast PR and Android gates plus post-merge `pnpm check:pr` passed; E1.3/E1.4 remain open and no real credentials or release mutation were used |
| #443 E2.3 | `019ff06b-2dc0-7350-906c-4baafbeecbe7` | `0746` | active | E2.1/E2.2 integrated | Add workflow/target drift fixtures, evidence-boundary documentation, and read-only branch-protection checks | No branch-protection or external repository setting mutation |

## Existing issue coordination

| Issue | State | Coordination rule |
| --- | --- | --- |
| #353 | needs-input | Preserve the existing visible worker; do not silently replace it. Resume physical acceptance only after relevant #436/#448/#439 evidence is integrated. |
| #352 | needs-info | Wait for recurrence; use #437's corrected harness to retain evidence. |
| #435 | needs-triage | Do not duplicate. Plan repair-flow work after #440 establishes session authority; hands-on acceptance remains last. |
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

- #440 B1.2 is integrated. #449, #450, #452, and #453 are dependency-ready but
  remain undispatched pending an approved wave; #451 still also depends on #436.
- Complete #436 before #451 starts; complete #451 D1.2 before #454 starts.
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
