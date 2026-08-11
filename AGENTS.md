# Agent Guidelines

## Required progress check

Before starting any repository work, every coordinator and worker must read:

1. `progress.md` in the current worktree.
2. `progress.local.md` in the primary checkout, when it exists.

For an isolated Git worktree, locate the primary checkout by resolving the
absolute Git common directory and taking its parent directory. For example,
`git rev-parse --path-format=absolute --git-common-dir` resolves to the primary
checkout's `.git` directory. Read `progress.local.md` from that checkout; do not
copy it into a task branch.

If either document is missing, stale, or conflicts with GitHub or concrete task
evidence, stop and report the discrepancy to the coordinator before changing
code. Never infer that a task is free merely because no branch or PR is visible.

## Progress ownership

- The thread-master coordinator owns updates to `progress.md` and
  `progress.local.md` in the primary checkout.
- Workers must report lifecycle changes, evidence, blockers, commits, PRs, and
  tracker state to the coordinator. They must not edit either progress document
  unless their task packet explicitly assigns that edit.
- `progress.md` contains shareable repository work state and may be committed.
- `progress.local.md` contains only local coordination state. It must never be
  staged, committed, pushed, attached to an Issue or PR, or copied into another
  worktree.
- The coordinator must update both documents after dispatch, meaningful worker
  progress, delivery, acceptance, merge, integration, deferral, or blocker
  changes.

## Dispatch ordering

Worker creation uses a two-phase ledger so a new worktree never races an older
progress snapshot:

1. Before creating any worker, the coordinator records the exact Issue/task,
   model, reasoning effort, language, acceptance style, and `dispatching` state
   in both progress documents, then commits and pushes `progress.md`.
2. A newly created worker may proceed when its packet exactly matches that
   pre-published `dispatching` entry even while its task ID and worktree fields
   are still marked `pending`.
3. Immediately after creation, the coordinator replaces the pending fields
   with the real task ID/worktree and advances the state to `active`.

A pending task ID is therefore not a conflict by itself. A worker must stop if
its Issue/task is absent, its model or scope differs, another active worker owns
the same task, or either progress document records a cancellation or blocker.

## System interaction boundary

Any change that touches controllers, operating-system effects, process or
network state, native adapters, simulated-host behavior, fixtures for those
effects, or their tests must read and follow
`.agents/skills/mish-transcript-driven-system-tests/SKILL.md` before work.
Such work must pass through the repository-owned effect boundary, record
bounded invocation/result transcripts, add deterministic replay or simulated
scenarios, and keep real-host acceptance separate from automated evidence.

## Worker coordination

- Use the exact task packet, linked Issue, dependency wave, acceptance style,
  language, and Luna Max compute tier assigned by the coordinator. In this
  repository, Luna Max means model `gpt-5.6-luna` with reasoning effort `max`.
- Do not expand scope, mutate unrelated tracker items, replace another worker,
  merge without explicit human acceptance, or claim real-system behavior from
  browser-only or simulated evidence.
- Preserve unrelated changes and run verification proportional to the affected
  contracts before delivery.
