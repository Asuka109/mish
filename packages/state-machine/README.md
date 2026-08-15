# `@mish/state-machine`

An isolated TypeScript execution kernel for the TypeScript/Electron/React
Native migration foundation. Rust remains the production implementation and
parity oracle at [`crates/state-machine/src/lib.rs`](../../crates/state-machine/src/lib.rs).
This package owns no product DTOs, host effects, Runtime/Profile/Settings/
Updater/Controller authority, or native integration.

## Parity matrix

| Rust kernel contract                           | TypeScript surface                                              | Covered guarantee                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Correlation`, `same_operation`, `with_effect` | `Correlation`, `sameOperation`, `sameCorrelation`, `withEffect` | Full authority, scope epoch, operation, admitted revision, and effect identity are required for completion acceptance.                          |
| `Transition`, `Disposition`                    | `Transition.*`, `transitionDisposition`, `Disposition`          | Domain reducers retain data-bearing state and exhaustive transition outcomes.                                                                   |
| `EffectBatch::one/from_first`                  | `EffectBatch.one/fromFirst`, `effectBatchOne/fromFirst`         | Every batch effect is owned; batch effects start in parallel and reducer application remains serialized.                                        |
| `RunnerHandle::try_admit/admit`                | `tryAdmit`, `admit`                                             | Bounded inbox saturation, domain rejection, and retired authority stay distinct.                                                                |
| `EffectExecutor` and `CancellationToken`       | `EffectExecutor`, `AbortSignal`                                 | Cancellation is delivered to owned effects; a non-cooperative task is force-settled during bounded shutdown.                                    |
| `TransitionObserver`                           | `TransitionObserver`                                            | Snapshot publication precedes observer notification; observer rejection retires the actor with a typed failure.                                 |
| `task_failed` and finalizer role               | `TaskFailure`, internal finalizer ownership                     | Panic, abort, correlation conflict, replacement, stale, and equal-effect completions never reach the domain reducer as business inputs.         |
| `RunnerHandle::shutdown`                       | `shutdown`, `dispose`                                           | Shutdown is out-of-band from the bounded admission queue, joins owned work, reports cleanup failure, and has bounded forced-retirement windows. |
| `abort_for_process_termination`                | `abortForProcessTermination`                                    | Process-style abort intentionally skips domain shutdown/finalizers.                                                                             |

## Intentional TypeScript differences

- Rust Tokio tasks can be aborted and joined directly. JavaScript promises
  cannot be stopped, so forced retirement emits one synthetic owned `aborted`
  settlement and ignores the eventual promise completion.
- JavaScript garbage collection is not a deterministic ownership boundary.
  Callers must explicitly await `shutdown()` or `dispose()` when compensation
  and finalizers must be observed; there is no `Drop` equivalent.
- Runner deadlines are millisecond values (`shutdownGraceMs` and
  `finalizerGraceMs`) and accept an injected scheduler for deterministic tests.
- The package intentionally has no host/device effects, persistence, network,
  signing, release, or deployment path. It is not evidence for those systems.

## Verification

```sh
pnpm --filter @mish/state-machine typecheck
pnpm --filter @mish/state-machine test:run
```

The tests use deferred promises and fake/logical timers rather than wall-clock
sleeps. They cover happy path, duplicate/concurrent admission, serial and
parallel batches, cancellation, timeout, replacement, stale/equal completion,
observer/reducer/executor failure, finalizer success/failure, forced retirement,
bounded cleanup, and process-style abort.
