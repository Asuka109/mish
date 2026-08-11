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

No implementation worker is active yet. Seven Wave 2A tasks are approved and
recorded below as `dispatching`; worker creation may begin only after this exact
manifest is committed and visible on `origin/main`.

## Wave 1 worker ledger

| Task | Worker task ID | Worktree | State | Dependencies | Acceptance | Latest evidence / next action |
| --- | --- | --- | --- | --- | --- | --- |
| #436 A1.1 | `019fefb6-dbbc-7dd2-bd7c-2fcb7c10fdb4` | `39f5` | integrated | none | accepted | PR #460 merged as `3044867`; bounded kernel and repository gates passed, A1.2/A1.3 remain open. |
| #448 A2.1 | `019fefb6-df13-7c43-aa76-8baa63f77248` | `d79d` | integrated | none for A2.1 | accepted | PR #458 merged as `168292a`; exact-restore adapter gates passed, A2.2/A2.3 remain open. |
| #437 A3.1 | `019fefb6-dba8-7be2-9833-24c5c22f6c53` | `b68e` | integrated | none | accepted | PR #459 merged as `25ac46b`; bounded Internal TUN scenarios passed, A3.2 remains open. |
| #438 A4.1 | `019fefb6-db98-70d1-af16-de78daa9dc75` | `cb17` | integrated | none | accepted | PR #455 merged as `9322e17`; local/remote gates passed, Issue checklist synced, A4.2 remains open. |
| #439 A5.1 | `019fefb6-dbaf-7681-9870-208086d1043d` | `e87b` | integrated | none | accepted | PR #461 merged as `5b454ea`; identity-bound process gates passed, Issue checklist synced, A5.2 remains open. |
| #440 B1.1 | `019fefb6-db98-70d1-af16-de5e1c0c457e` | `3ab4` | integrated | none | accepted | PR #457 merged as `8c23789`; local/remote gates passed, Issue checklist synced, B1.2-B1.5 remain open. |
| #443 E2.1 | `019fefb6-dbbd-78a1-b4d1-4cca4ae1099b` | `2d87` | integrated | none | accepted | PR #456 merged as `f27a711a`; Fast PR gate passed, Issue checklist synced, E2.2/E2.3 remain open. |

## Wave 2A dispatch manifest

All entries use model `gpt-5.6-luna`, reasoning effort `max`, Chinese reporting,
confirmation-only acceptance, and final-only parent escalation. This wave is
AFK and authorizes no real-host mutation or hands-on acceptance.

| Task | Worker task ID | Worktree | State | Dependencies | Intended result | Latest evidence / next action |
| --- | --- | --- | --- | --- | --- | --- |
| #440 B1.2 | pending | pending | dispatching | B1.1 integrated | One RPC Session Authority for baselines, generations, stale rejection, and deterministic tests | Create after manifest publication; do not migrate B1.3-B1.5 consumers. |
| #436 A1.2 | pending | pending | dispatching | A1.1 integrated | Migrate Capture shutdown/cancellation to the shared runtime with cleanup, panic, and replacement transcripts | Create after manifest publication; preserve A1.3 documentation/gate scope. |
| #437 A3.2 | pending | pending | dispatching | A3.1 integrated | Complete Internal TUN fault matrix, schema/privacy checks, and RPC/React journeys | Create after manifest publication; merge latest A1.2 first if shared lifecycle semantics overlap. |
| #438 A4.2 | pending | pending | dispatching | A4.1 integrated | Add only missing Browser fixture production-exclusion enforcement and residual behavior coverage | Create after manifest publication; reuse A4.1 Browser tests instead of duplicating them. |
| #443 E2.2 | pending | pending | dispatching | E2.1 integrated | Enforce relevant target compile, Clippy, and test coverage for platform crates | Create after manifest publication; E2.3 drift/docs/branch-protection evidence remains separate. |
| #441 C2.1 | pending | pending | dispatching | none | Private durable staging and atomic Profile generation publication | Create after manifest publication; do not migrate readers assigned to C2.2. |
| #442 E1.1 | pending | pending | dispatching | none | Release executable/path containment under private no-follow roots | Create after manifest publication; no signing credentials or real release effects. |

## Planned issue graph

| Theme | Issue | State | Blocked by | Acceptance |
| --- | --- | --- | --- | --- |
| Owned operations | #436 | dispatching: A1.2; A1.1 integrated | none | confirmation-only |
| System Proxy restoration | #448 | A2.1 integrated; A2.2/A2.3 planned | #436 A1.1 for A2.2 | A2.1/A2.2 confirmation-only; A2.3 hands-on |
| SimulatedHost truthfulness | #437 | dispatching: A3.2; A3.1 integrated | none | confirmation-only |
| Browser fixture truthfulness | #438 | dispatching: A4.2; A4.1 integrated | none | confirmation-only |
| Process identity | #439 | A5.1 integrated; A5.2 planned | none | confirmation-only |
| RPC Session Authority | #440 | dispatching: B1.2; B1.1 integrated | none | confirmation-only |
| Profile credential privacy | #449 | blocked | #440 | confirmation-only |
| Atomic profile generations | #441 | dispatching: C2.1 | none | confirmation-only |
| Backup preview authority | #450 | blocked | #440 | confirmation-only |
| Android VPN authority | #451 | blocked | #436, #440 | confirmation-only; physical residual stays in #268 |
| Mobile Core provenance | #454 | blocked | #451 | confirmation-only |
| Release trust boundary | #442 | dispatching: E1.1 | none | confirmation-only; real signing stays in #173 |
| CI policy coverage | #443 | dispatching: E2.2; E2.1 integrated | none | confirmation-only |
| Settings editor serialization | #452 | blocked | #440 | confirmation-only |
| Remove Profile Patch Editor | #453 | blocked | #440 | confirmation-only |
| Lazy-route recovery | #444 | planned | none | confirmation-only |
| Traffic details accessibility | #445 | planned | none | confirmation-only |
| Clipboard failure feedback | #446 | planned | none | confirmation-only |
| Muted-text contrast | #447 | planned | none | confirmation-only |

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

- Complete #440 B1.2 before #449, #450, #451, #452, or #453 starts.
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
