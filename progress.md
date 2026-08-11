# Mish Delivery Progress

Last updated: 2026-08-11 (Asia/Shanghai)
Owner: thread-master coordinator

## Current checkpoint

- Backlog preparation and Wave 1 were explicitly approved by the maintainer.
- The governance baseline is being published before worker dispatch.
- No new implementation worker has been dispatched for issues #436-#454.
- All planned workers must use Luna Max (`gpt-5.6-sol`) with `high` or `medium`
  reasoning and report in Chinese.
- AFK, confirmation-only work is scheduled before hands-on acceptance work.
- Maximum implementation concurrency is 10 workers, subject to dependency and
  integration-surface limits.

## Active tasks

Wave 1 is approved. Worker IDs are added here by the coordinator immediately
after isolated tasks are created.

## Planned issue graph

| Theme | Issue | State | Blocked by | Acceptance |
| --- | --- | --- | --- | --- |
| Owned operations | #436 | planned | none | confirmation-only |
| System Proxy restoration | #448 | planned | #436 for task A2.2 | A2.1/A2.2 confirmation-only; A2.3 hands-on |
| SimulatedHost truthfulness | #437 | planned | none | confirmation-only |
| Browser fixture truthfulness | #438 | planned | none | confirmation-only |
| Process identity | #439 | planned | none | confirmation-only |
| RPC Session Authority | #440 | planned | none | confirmation-only |
| Profile credential privacy | #449 | blocked | #440 | confirmation-only |
| Atomic profile generations | #441 | planned | none | confirmation-only |
| Backup preview authority | #450 | blocked | #440 | confirmation-only |
| Android VPN authority | #451 | blocked | #436, #440 | confirmation-only; physical residual stays in #268 |
| Mobile Core provenance | #454 | blocked | #451 | confirmation-only |
| Release trust boundary | #442 | planned | none | confirmation-only; real signing stays in #173 |
| CI policy coverage | #443 | planned | none | confirmation-only |
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
| #436 A1.1 | Bounded forced-retirement/finalizer/shutdown kernel | `gpt-5.6-sol/high` | none | ready |
| #448 A2.1 | Exact System Proxy restore adapter | `gpt-5.6-sol/high` | none for A2.1 | ready |
| #437 A3.1 | Truthful effect ordering, ownership, and bounded faults | `gpt-5.6-sol/medium` | none | ready |
| #438 A4.1 | Typed unsupported/simulated browser Capture behavior | `gpt-5.6-sol/medium` | none | ready |
| #439 A5.1 | Identity-bound Core termination and probes | `gpt-5.6-sol/high` | none | ready |
| #440 B1.1 | Bounded RPC transport IDs, deadlines, and envelopes | `gpt-5.6-sol/medium` | none | ready |
| #443 E2.1 | Complete workflow/job policy parsing | `gpt-5.6-sol/medium` | none | ready |

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

For every dispatched task, add or update an Active task row with Issue/task,
worker task ID, branch/worktree, lifecycle state, dependencies, latest concrete
evidence, acceptance style, PR, tracker state, and next action. Move completed
work through accepted, merged, and integrated separately; passing CI alone is
not acceptance.
