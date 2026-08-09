# Documentation evidence contract

Repository entry documentation must remain useful after its authoring commit.
This contract separates stable intent from volatile observations and keeps
tracker drift detectable without making GitHub an ordinary build dependency.

## Claim classes

### Durable contract

A durable contract states ownership, invariants, safety boundaries, or intended
compatibility. It lives in the narrowest architecture or operations document
that owns the domain. An entry page links to it instead of repeating its current
implementation or availability.

Contract changes update the owning document and its executable or acceptance
gate together. A commit hash, date, test count, workflow result, artifact ID,
or live platform setting is not a durable contract.

### Dated checkpoint

A dated checkpoint records observations at an exact date and revision. It may
include test counts, workflow runs, artifacts, live settings, and capability
observations only when their scope and evidence limit are explicit.

Checkpoint evidence is immutable historical evidence. A later unrelated run
cannot retroactively satisfy a gate that was missing, unavailable, failed, or
not executed at the checkpoint. Corrections are appended as a new dated record
or a clearly attributed erratum; they are not silently rewritten as old proof.

### Generated or read-back evidence

Generated evidence comes from checked repository metadata or a deterministic
tool. External facts use a named read-back with its source and capture time.
Generated output is evidence only for the inputs it names.

GitHub read-back and offline verification are deliberately separate:

1. A maintainer reads the bounded Issue set from `Asuka109/mish` with `gh`.
2. The maintainer updates
   [`documentation-tracker-registry.json`](documentation-tracker-registry.json)
   with the exact state, state reason, update time, and documentary role.
3. `pnpm check:docs` validates that checked-in registry and canonical files
   without network access or a GitHub token.

The registry is a reviewable snapshot, not a promise that GitHub has not changed
since `readBackAt`. A delivery that depends on current tracker state performs a
new authoritative read-back before publication and again before tracker sync.

## Bounded tracker references

Only paths listed in `canonicalPaths` are part of the tracker drift gate. Every
Issue reference in those files must have exactly one registry record and role:

- `active-dependency`: future work that is allowed only while the Issue is open;
- `completed-delivery`: completed work cited as delivered evidence;
- `historical-checkpoint`: a dated or explicitly historical source context;
- `superseded-decision`: rejected or retired work retained for rationale;
- `decision-context`: a closed tracker cited only to explain a durable boundary.

The gate rejects duplicate Issue records and duplicate path/Issue references.
It also rejects closed Issues classified as active dependencies, open Issues
classified as completed history, future-tense residue around closed references,
and superseded references without explicit rejected/retired context.

Pull requests must be named as `PR #N`, not left as ambiguous bare `#N`, when a
nearby Issue reference is classified by the gate.

## Entry-path maintenance

Keep [`../current-state.md`](../current-state.md) and
[`../README.md`](../README.md) short. They route readers to domain authority and
the latest relevant dated record. New volatile facts belong in an owning quality
record or a deterministic manifest, never copied across entry pages.
