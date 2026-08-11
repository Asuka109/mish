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

Seven Luna Max workers are active from the pre-published manifest and clean
detached baseline `12831ad`.

## Wave 1 worker ledger

| Task | Worker task ID | Worktree | State | Dependencies | Acceptance | Latest evidence / next action |
| --- | --- | --- | --- | --- | --- | --- |
| #436 A1.1 | `019fefb6-dbbc-7dd2-bd7c-2fcb7c10fdb4` | `39f5` | active | none | confirmation-only | Clean detached `12831ad`; bounded owned-operation kernel only. |
| #448 A2.1 | `019fefb6-df13-7c43-aa76-8baa63f77248` | `d79d` | active | none for A2.1 | confirmation-only | Clean detached `12831ad`; no host mutation is authorized. |
| #437 A3.1 | `019fefb6-dba8-7be2-9833-24c5c22f6c53` | `b68e` | active | none | confirmation-only | Clean detached `12831ad`; scope is limited to Rust model semantics. |
| #438 A4.1 | `019fefb6-db98-70d1-af16-de78daa9dc75` | `cb17` | active | none | confirmation-only | Clean detached `12831ad`; scope is limited to truthful fixture behavior. |
| #439 A5.1 | `019fefb6-dbaf-7681-9870-208086d1043d` | `e87b` | active | none | confirmation-only | Clean detached `12831ad`; no real process signal is authorized. |
| #440 B1.1 | `019fefb6-db98-70d1-af16-de5e1c0c457e` | `3ab4` | active | none | confirmation-only | Clean detached `12831ad`; scope is limited to transport hardening. |
| #443 E2.1 | `019fefb6-dbbd-78a1-b4d1-4cca4ae1099b` | `2d87` | active | none | confirmation-only | Clean detached `12831ad`; no repository settings mutation is authorized. |

## Planned issue graph

| Theme | Issue | State | Blocked by | Acceptance |
| --- | --- | --- | --- | --- |
| Owned operations | #436 | active: A1.1 | none | confirmation-only |
| System Proxy restoration | #448 | active: A2.1 | #436 for task A2.2 | A2.1/A2.2 confirmation-only; A2.3 hands-on |
| SimulatedHost truthfulness | #437 | active: A3.1 | none | confirmation-only |
| Browser fixture truthfulness | #438 | active: A4.1 | none | confirmation-only |
| Process identity | #439 | active: A5.1 | none | confirmation-only |
| RPC Session Authority | #440 | active: B1.1 | none | confirmation-only |
| Profile credential privacy | #449 | blocked | #440 | confirmation-only |
| Atomic profile generations | #441 | planned | none | confirmation-only |
| Backup preview authority | #450 | blocked | #440 | confirmation-only |
| Android VPN authority | #451 | blocked | #436, #440 | confirmation-only; physical residual stays in #268 |
| Mobile Core provenance | #454 | blocked | #451 | confirmation-only |
| Release trust boundary | #442 | planned | none | confirmation-only; real signing stays in #173 |
| CI policy coverage | #443 | active: E2.1 | none | confirmation-only |
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
| #436 A1.1 | Bounded forced-retirement/finalizer/shutdown kernel | `gpt-5.6-luna/max` | none | active |
| #448 A2.1 | Exact System Proxy restore adapter | `gpt-5.6-luna/max` | none for A2.1 | active |
| #437 A3.1 | Truthful effect ordering, ownership, and bounded faults | `gpt-5.6-luna/max` | none | active |
| #438 A4.1 | Typed unsupported/simulated browser Capture behavior | `gpt-5.6-luna/max` | none | active |
| #439 A5.1 | Identity-bound Core termination and probes | `gpt-5.6-luna/max` | none | active |
| #440 B1.1 | Bounded RPC transport IDs, deadlines, and envelopes | `gpt-5.6-luna/max` | none | active |
| #443 E2.1 | Complete workflow/job policy parsing | `gpt-5.6-luna/max` | none | active |

All seven tasks are AFK and confirmation-only. Each worker receives an isolated
worktree, one linked Issue/task, Chinese reporting, final-only escalation, and
authority to commit/push/open a PR after dispatch. Merge remains gated on
explicit human acceptance.

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
