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
- retirement of mismatched or stale completions without machine-state mutation;
- a bounded evidence ring containing hashed authority/operation identity and
  state/input/disposition labels.

The runner checks a completed task against the correlation it owned and asks
the machine whether that owned effect is still current for the present state
before it calls the reducer. A foreign completion and an otherwise well-formed
completion from an operation that has since been replaced are never domain
inputs: the runner records one bounded `effect-completion-conflict` retirement
entry and constructs exactly one domain finalizer from the owned original
correlation. Every machine must implement this current-effect predicate from
its own State and Effect vocabulary.
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

Durable recovery is optional. When a Unix machine needs it, the kernel offers
a versioned, bounded, atomic, mode-`0600`, owner-checked record keyed by the
full operation correlation. Other platforms must provide an equivalently
ownership-checked domain adapter before opting in. Product domains still own
the payload and external reconciliation policy.

On restart, a record is evidence that compensation or resumption may be
needed; it is never more authoritative than fresh OS, process, filesystem, or
network observation. The adapter resumes or compensates idempotently only when
ownership still matches. Ambiguous, foreign, partial, stale, malformed, or
changed state becomes `RecoveryRequired` without guessing.

The TUN network journal remains the canonical #295 recovery boundary and is
reused rather than copied into a generic event log. Updater candidate recovery
continues to re-verify signed metadata and staged bytes. Package receipts and
installation enrollment remain package-domain records.

## Adoption

The conforming machines are Updater Check, Updater Continuation, Internal TUN
Alpha package install/repair/uninstall, TUN Helper/Core/network lifecycle, and
the Capture outer lifecycle. Updater Continuation owns Download, Verify,
immutable candidate commit, Ready, cancellation, interruption, retirement, and
restart re-verification. Each domain owns its `State`, `Input`, `Effect`,
projection, and error vocabulary; the kernel supplies only bounded admission,
task ownership, correlation, finalization, and evidence. Future work such as #288 and #289 must
consume this convention when it introduces a high-risk lifecycle, while
retaining its own vocabulary and recovery boundary. Migration-required
registry entries are independent vertical slices; this change does not rewrite
them or imply that every enum named `State` belongs in the kernel.

Internal TUN Alpha remains `healthy-disabled` by default. The kernel adds no
package enable command, production signing, public release, or new route, DNS,
or System Proxy mutation capability.
