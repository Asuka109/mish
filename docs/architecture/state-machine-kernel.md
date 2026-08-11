# Typed state-machine kernel

Mish uses a small repository-owned Rust execution kernel for internal
lifecycles whose correctness depends on ordered external effects, cancellation,
failure recovery, or exact ownership. The kernel is an execution convention,
not a universal Mish state or a business workflow framework.

## Eligibility rule

A lifecycle belongs in the kernel when it has multiple externally observed
steps and at least one of these properties:

- cancellation, replacement, timeout, retry, or commit-point races;
- process, socket, filesystem, network, or administrator-authorization effects;
- compensation or durable recovery after a partial mutation;
- success that must be proven by a later observation rather than by intent;
- an effect completion that can arrive after its operation or scope was retired.

Ephemeral React interaction state, connection-local presentation, and simple
bounded one-shot I/O stay outside. The checked
[`state-machine-registry.json`](state-machine-registry.json) records every
reviewed high-risk lifecycle as `conforming`, `migration-required`, or
`intentionally-excluded`. The PR gate rejects an incomplete registry or a
conforming entry whose canonical machine disappeared.

## Reducer, runner, and adapter boundary

Each product domain owns data-bearing `State`, `Input`, `Effect`, projection,
and error types plus one synchronous reducer. A reducer performs no I/O, awaits,
clock reads, logging, persistence, task creation, or hidden global mutation.
Its exhaustive result distinguishes accepted, rejected, unchanged,
effect-emitting, committed, cancelled, failed, retired, and
recovery-required transitions.

`mish-state-machine` owns only the common execution mechanics:

- a bounded Tokio admission inbox;
- machine authority, scope epoch, operation ID, admitted revision, and effect
  ID correlation;
- every effect task, cancellation token, join, panic/abort finalizer, and
  shutdown grace period;
- retirement of mismatched or stale completions without machine-state mutation.

The runner checks a completed task against the correlation it owned and asks
the machine whether that owned effect is still current for the present state
before it calls the reducer. A foreign completion and an otherwise well-formed
completion from an operation that has since been replaced are never domain
inputs: the runner constructs exactly one domain finalizer from the owned
original correlation. Every machine must implement this current-effect
predicate from its own State and Effect vocabulary. Domains that need transition
diagnostics record bounded, redacted evidence through their existing transition
observer; the kernel does not retain a second generic event stream.
Domain correlation guards remain required as defense in depth for inputs that
arrive through ordinary admission rather than an owned effect task.

Callers that need recovery-specific admission behavior use `try_admit`: a
domain rejection, a saturated inbox, and a retired runner are distinct typed
results. Domain adapters may deliberately map those cases back into their own
error vocabulary; for example, Profile activation treats saturation as a
conflict that may be retried and retirement as unavailable authority.

Runner shutdown returns a typed retirement record containing the last snapshot,
transition disposition, and terminal reason. Rejected shutdown transitions and
an actor that panicked, was aborted, or retired before replying are data rather
than `expect`/panic paths. Effect panic and bounded-grace abort still enter the
domain through one owned `task_failed` finalizer. Repeating explicit shutdown is
idempotent. Dropping the last runner owner requests the same bounded shutdown
and drain path; it detaches rather than aborting the actor, so compensation and
owned finalizers are not silently bypassed. Owners that must observe completion
still call and await explicit shutdown before releasing their last handle.
Crash/restart harnesses use the separately named process-termination abort,
which intentionally runs neither shutdown nor finalizers and cannot be confused
with ordinary last-owner retirement.

Effect adapters own platform and network I/O. They return explicit inputs to
the reducer. Adapter resource locks do not become machine authority, and no
detached task or lock held across an await can mutate the reducer-owned state.
Domain projections remain the only public DTO/RPC surface.

## Single lifecycle authority for Capture owned operations

The `capture-owned-operation-lifecycle` contract in
[`state-machine-registry.json`](state-machine-registry.json) defines one
lifecycle authority for Capture operations. The contract has deliberately
separate implementation seams, but those seams do not create separate
lifecycles:

| Concern                              | Sole owner                                                                                                                                                                          | Boundary that is not an owner                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Forced retirement and task ownership | `mish-state-machine`'s `RunnerHandle`, `finish_effect`, and bounded `drain` path                                                                                                    | `CaptureReconciler` only holds the runner; `abort_for_process_termination` is the explicitly separate process-crash path             |
| Cancellation                         | The kernel-owned task cancellation token, followed by `CaptureMachine::task_failed` or `TaskCancelled`                                                                              | `CaptureRuntimeTransition` reserves replacement admission; it does not cancel or finalize a machine                                  |
| Finalization                         | `CaptureMachine::finalizer` creates the one `CaptureEffect::Finalize`; the kernel owns its task, correlation, join, and deadline                                                    | `CaptureEffectAdapter` only executes the typed effect and returns an input                                                           |
| Replacement                          | `CaptureMachine` admits `TransitionMode::RuntimeReplacement` and the kernel retires stale completions by correlation                                                                | Profile/Core activation may hold the `CaptureRuntimeTransition` guard; it cannot write Capture state or publish a replacement result |
| Shutdown                             | `CaptureReconciler` is the only production facade that calls the Capture runner's `shutdown`; the kernel applies `CaptureInput::Shutdown`, drains, and returns `RetirementTerminal` | System Proxy/TUN reconcilers restore platform state; they do not retire the Capture machine                                          |

`CaptureMachine` is the data-bearing domain reducer and owns the Capture
transition vocabulary. `CaptureReconciler` owns exactly one
`RunnerHandle<CaptureMachine>` and is the only admission/shutdown facade.
`CaptureEffectAdapter`, `SystemProxyReconciler`, and `TunReconciler` are effect
seams and serialized platform guards, not lifecycle authorities. The
`CaptureProjectionObserver` and the feature-gated `CaptureLifecycleObserver`
only project bounded transitions to consumers; the SimulatedHost transcript
sink is test evidence and never owns a reducer, task, cancellation token, or
finalizer.

This distinction is mandatory for every operation phase: forced retirement,
cancellation, finalization, replacement, and shutdown must remain one
correlated path through the kernel and Capture reducer. A new Capture runner,
direct `CaptureInput::TaskFailed`, direct `CaptureEffect::Finalize`, detached
Capture task, second lifecycle observer, or platform callback that publishes a
Capture terminal state is an authority violation. The registry and its static
inspection fail closed when an owner path, marker, responsibility, or
non-owner boundary drifts. Normal shutdown and its bounded finalizer window
remain distinct from process termination, which intentionally does not run
application finalizers and is used only by restart/crash harnesses.

## Desired state is not observed state

An admitted command expresses intent only. `Starting`, `Applying`,
`Installing`, or `Restoring` cannot publish `Running`, `Enabled`, `Installed`,
`Ready`, or `healthy-disabled`. A later effect must re-observe the relevant
process, socket, launchd job, receipt, signature, route, DNS, interface, or
other authority and feed that observation back through the reducer.

Updater Check preserves its discovery-to-commit cutoff. Internal TUN package
installation reaches `healthy-disabled` only after fixed artifact, receipt,
launchd, socket, protocol, enrollment, Core absence, and network-disabled
verification. The Helper/Core/network machine reaches enabled or disabled only
after its existing private-socket, P-256, Core ownership, utun, route, DNS, and
network journal contracts agree.

Capture's outer machine preserves the existing System Proxy and TUN
reconcilers as effect adapters. A request, a successful platform command, or a
desired selection can publish only `Pending`. `Applied` is committed only after
a separate authoritative Core/platform observation returns through the
reducer. Observation failure, cancellation, panic, abort, runtime replacement,
or shutdown runs an owned finalizer and ends in a typed failed,
recovery-required, or retired terminal state.

## Durable recovery

Durable recovery is domain-owned. The kernel supplies no generic recovery
record or persistence adapter: each product domain owns its payload, storage
constraints, ownership checks, and external reconciliation policy.

On restart, a record is evidence that compensation or resumption may be
needed; it is never more authoritative than fresh OS, process, filesystem, or
network observation. The adapter resumes or compensates idempotently only when
ownership still matches. Ambiguous, foreign, partial, stale, malformed, or
changed state becomes `RecoveryRequired` without guessing.

The TUN network journal delivered through completed Issue #295 remains the
canonical recovery boundary and is reused rather than copied into a generic
event log. Updater candidate recovery
continues to re-verify signed metadata and staged bytes. Package receipts and
installation enrollment remain package-domain records.

## Adoption

The conforming machines are Updater Check, Updater Continuation, Internal TUN
Alpha package install/repair/uninstall, TUN Helper/Core/network lifecycle, and
the Capture outer lifecycle, plus the consequential Traffic source-session and
close-command boundary. The Traffic machine owns only binding, live, replacing,
ended, failed/reconciling, and retired source authority together with command
correlation; Controller rows, rules, filters, sorting, pause, selection, Closed
history, and React composition remain in their existing owners. Updater Continuation owns Download, Verify,
immutable candidate commit, Ready, cancellation, interruption, retirement, and
restart re-verification. Each domain owns its `State`, `Input`, `Effect`,
projection, and error vocabulary; the kernel supplies only bounded admission,
task ownership, correlation, finalization, shutdown, and transition observers.
Completed Issue #288 and completed Issue #289 adopted this convention while
retaining their domain vocabulary and recovery boundaries. Migration-required
registry entries are independent vertical slices; this change does not rewrite
them or imply that every enum named `State` belongs in the kernel.

Internal TUN Alpha remains `healthy-disabled` by default. The kernel adds no
package enable command, production signing, public release, or new route, DNS,
or System Proxy mutation capability.
