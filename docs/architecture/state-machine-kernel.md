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

The first conforming machines are Updater Check, Internal TUN Alpha package
install/repair/uninstall, and TUN Helper/Core/network lifecycle. Future work
such as #288 and #289 must consume this convention when it introduces a
high-risk lifecycle, while retaining its own vocabulary and recovery boundary.
Migration-required registry entries are independent vertical slices; this
change does not rewrite them or imply that every enum named `State` belongs in
the kernel.

Internal TUN Alpha remains `healthy-disabled` by default. The kernel adds no
package enable command, production signing, public release, or new route, DNS,
or System Proxy mutation capability.
