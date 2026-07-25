# Candidate home isolation

## RFC status

- **Question:** Does every Profile activation still need a completely fresh
  private Mihomo candidate home?
- **Status:** Proposed no-change decision, pending maintainer acceptance of
  Issue #185.
- **Scope:** Candidate file isolation, preparation cost, validation mutation,
  promotion, rollback, retirement, cancellation, and crash recovery.
- **Non-goals:** GeoData fallback/update design, packaged-runtime fixes,
  activation UX, or a different one-Core ownership model.

## Existing behavior

A **candidate home** is the private filesystem workspace for one attempted
Profile activation. It is not the selected Profile, the persistent Profile
store, or the active-state record. It contains the exact files that the
candidate Mihomo process may read or mutate during validation and, if accepted,
while running.

Every activation currently creates a new UUID-scoped root:

```text
runtime/
├── activation-state.json
├── core-ownership.json
├── profile-selection-cache/
│   └── <profile-id>/<effective-fingerprint>/cache.db
└── candidates/
    ├── <active-uuid>/
    │   ├── config.yaml
    │   └── home/
    │       ├── GeoSite.dat
    │       ├── GeoIP.dat
    │       ├── geoip.metadb
    │       ├── ASN.mmdb
    │       ├── cache.db
    │       └── <Profile-defined provider resources>
    └── .staging-<new-uuid>/
        ├── config.yaml
        └── home/
```

The mechanism is transactional:

1. Rust creates `.staging-<uuid>` with private permissions.
2. Mish verifies the packaged GeoData manifest and source digests, then writes
   private candidate files.
3. Mish restores only the selection cache whose Profile ID and effective
   fingerprint match the attempted activation.
4. Rust generates the candidate-specific configuration and invokes the exact
   pinned Mihomo with `-t`.
5. Successful validation promotes the staging directory by rename. A failed or
   cancelled validation deletes only that staging directory.
6. Mish stops the prior Core only after the replacement is fully prepared,
   records launch ownership for the exact new paths, and starts the candidate.
7. The candidate becomes authoritative only after process, listener,
   Controller version, and first-snapshot readiness succeed and Rust commits
   active state.
8. The prior candidate is then retired: Mish persists its bounded selection
   cache and deletes its entire root.
9. Any failure before commit stops and deletes the new candidate and restores
   the prior Core/capture intent. Startup recovery reconciles the ownership
   journal before deleting stale UUID roots.

This design deliberately permits two candidate roots during replacement but
never two active Cores. The prior root remains rollback authority while the new
root is validated and started.

## Why review it

The packaged GeoData snapshot is about 41 MiB, and the existing implementation
verifies and writes those assets for every attempted activation. This raises a
reasonable performance question: could Mish retain a home per Profile or
effective fingerprint, or use copy-on-write files, while preserving the same
transactional guarantees?

The review must answer two different questions:

1. **Logical isolation:** Which files and guarantees require a fresh root?
2. **Physical copying:** Can private candidate files be created more cheaply
   without changing that logical isolation?

Conflating them would be unsafe. APFS cloning may optimize physical allocation
while retaining independent files; persistent-home reuse changes the logical
isolation and introduces stale mutable state.

## Evaluation criteria

A narrower design is acceptable only if it:

- preserves one active Core and one authoritative ownership record;
- prevents validation, active, updating, and retiring runtimes from mutating
  another candidate's files;
- keeps rejected Profiles, cancellation, rollback, and cleanup exact;
- preserves pinned validation, listener readiness, selection-cache scoping,
  crash recovery, and Rust-authoritative publication;
- has a portable sequential fallback and no mutable symlink or hard-link
  authority; and
- produces a material end-to-end activation improvement, defined here as at
  least 10% of observed cold activation without a meaningful tail regression.

## Conclusion

Mish retains one fresh private Mihomo candidate root for every Profile
activation. The review found no storage proposal that can produce a material
end-to-end launch improvement while preserving the current transactional
Interface. The bundled GeoData snapshot remains the shared immutable source;
each validation and runtime still receives private regular-file copies.

This is a no-change architecture decision. It does not change GeoData update or
fallback behavior, packaged-runtime recovery, or activation UX.

## Module and Seam

`MihomoActivationManager` is the deep Module for candidate preparation, Core
handoff, rollback, and retirement. Its external Interface is activation,
shutdown, recovery, and the committed runtime/state projection. Candidate-root
creation is an internal Seam: callers do not select a storage Adapter.

The current Interface guarantees:

- one active Core and one authoritative Core ownership record;
- validation by the exact pinned Core before launch;
- no state publication before listener and Controller readiness;
- exact rejected-Profile isolation;
- Profile-and-effective-fingerprint selection-cache scoping;
- cancellation and failure rollback without partial authority;
- crash recovery from the ownership journal and removal of stale candidates;
- retirement and exact cleanup of the prior or rejected candidate; and
- Rust-authoritative activation and runtime-host publication.

## Candidate lifecycle DAG

```mermaid
flowchart TD
  Recover["Recover startup ownership journal"] --> Prune["Prune stale UUID candidate and staging roots"]
  Prune --> Validate["Validate Profile record and effective fingerprint"]
  Validate --> Lock["Acquire activation-state mutex"]
  Lock --> Stage["Create candidates/.staging-UUID (0700)"]
  Stage --> Seed["Verify bundled manifest, file shape, sizes, SHA-256; write four private GeoData files"]
  Seed --> Cache["Copy bounded Profile + effective-fingerprint cache.db when enabled"]
  Cache --> Config["Generate candidate config.yaml (0600)"]
  Config --> Version["Validate exact pinned Mihomo version"]
  Version --> Test["Run mihomo -d candidate-home -f candidate-config -t"]
  Test -->|success| Promote["Rename .staging-UUID to candidates/UUID"]
  Test -->|failure or cancellation| DeleteStage["Guard deletes staging root"]
  Promote --> Capture["Begin capture transition and suspend prior capture if required"]
  Capture --> StopPrior["Stop prior Core"]
  StopPrior --> Intent["Persist ownership launch intent for exact candidate paths and token"]
  Intent --> Spawn["Spawn candidate Core and persist PID/start identity"]
  Spawn --> Ready["Confirm process, mixed listener, Controller version, and first snapshot"]
  Ready --> Resume["Resume prior capture intent"]
  Resume --> Commit["Atomically replace activation-state.json"]
  Commit --> Publish["Replace Rust runtime host and publish Profile projection"]
  Publish --> Retire["Persist prior cache.db, then delete prior candidate root"]
  Capture -->|failure| Rollback["Stop/delete candidate and restore prior Core/capture"]
  StopPrior -->|failure| Rollback
  Spawn -->|start, exit, readiness, or cancellation failure| Rollback
  Ready -->|failure| Rollback
  Resume -->|failure| Rollback
  Commit -->|failure| Rollback
  Rollback -->|prior restore succeeds| Preserve["Preserve prior authority"]
  Rollback -->|prior restore fails| SafeStop["Clear active state and publish explicit safe stop"]
```

The activation-state mutex serializes the handoff, but serialization alone does
not isolate validation-time or runtime file mutation. The fresh root provides
that locality: every candidate's mutable file set and cleanup target are one
directory.

## File ownership and mutation analysis

| Resource                                               | Source                                                                     | Candidate behavior                                                                                                                                                                      | Required isolation                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `config.yaml`                                          | Generated from the persisted normalized Profile and managed runtime policy | Read by validation and runtime; candidate-specific and contains private controller configuration                                                                                        | Private regular file                                   |
| `GeoSite.dat`, `GeoIP.dat`, `geoip.metadb`, `ASN.mmdb` | Verified packaged snapshot                                                 | Pinned `mihomo -t` reads them. Mihomo retains authority to create or replace missing runtime GeoData inside `-d`; Mish cannot treat the candidate paths as immutable runtime authority. | Shared source is safe; candidate paths remain private  |
| `cache.db`                                             | Profile + effective-fingerprint cache                                      | Mihomo mutates policy selections while running; Mish copies it out only at retirement                                                                                                   | Private and fingerprint-scoped                         |
| Relative provider files                                | Profile configuration, constrained to remain under the managed home        | Provider initialization and update can write candidate-local resources                                                                                                                  | Private; the complete mutable set is Profile-dependent |
| `core-ownership.json`                                  | Rust ownership Module                                                      | Atomically records exact binary, candidate home/config, generation, token, PID, and start identity                                                                                      | One authoritative record outside candidate homes       |
| `activation-state.json`                                | Rust activation Module                                                     | Atomically publishes display-safe active identity only after readiness                                                                                                                  | One authoritative record outside candidate homes       |

Pinned v1.19.29 validation against the four prepared production assets did not
change their hashes for the representative fixture. That observation is not an
immutability guarantee: validation deliberately owns missing-GeoData recovery,
and the running Core can mutate `cache.db` and Profile-defined relative
provider resources. A persistent home would therefore need a complete
Profile-dependent reset or snapshot protocol before every validation. That
protocol recreates the private-candidate problem and adds stale-state and crash
recovery states to the Interface.

No symlink or hard-link proposal is safe. An APFS clone produces independent
copy-on-write files and is not the same as a hard link, but it still needs exact
source verification and a portable sequential Adapter. It changes only the
physical-copy implementation; it does not justify persistent homes or a
narrower isolation Seam.

## Reproducible performance evidence

The repository-owned file harness is:

```sh
pnpm measure:candidate-home -- --iterations 9
node --test scripts/measure-candidate-home.test.ts
```

It verifies the production manifest and 42,881,021 bytes on every sample,
publishes a UUID staging directory through rename, checks the completed files,
and measures injected failure and cancellation cleanup. `current` matches the
Rust implementation: read and hash every asset, then write private files.
`verified-sequential` performs the same verification followed by portable file
copies. `verified-clone` performs the same verification followed by macOS
`cp -c` APFS clones; the production-independent process Adapter makes this a
conservative prototype rather than an implementation benchmark.

Measurements on an Apple Silicon APFS SSD:

| Preparation Adapter             | First sample |  Median |      p95 | Result                 |
| ------------------------------- | -----------: | ------: | -------: | ---------------------- |
| Current verified private writes |      36.5 ms | 46.7 ms |  67.1 ms | Baseline               |
| Verified sequential copies      |      65.6 ms | 69.9 ms | 108.3 ms | Slower                 |
| Verified APFS clone prototype   |      54.1 ms | 79.8 ms | 206.3 ms | Slower and higher tail |

An attempted Node `COPYFILE_FICLONE_FORCE` Adapter returned `ENOSYS` on the same
APFS host, demonstrating why clone availability requires an explicit platform
Adapter and fallback. Native `/bin/cp -c` succeeded. Even a zero-cost native
clone cannot remove the per-activation read and SHA-256 verification; the
observed current preparation cost is already only tens of milliseconds.

The ignored integration harnesses exercise the whole activation Interface with
the production GeoData snapshot:

```sh
cargo test -p mish-bridge --test mihomo_activation \
  measures_fixture_private_candidate_home_activation_paths \
  -- --ignored --nocapture --test-threads=1

MISH_MIHOMO_MEASURE_BIN="$PWD/.scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29" \
  cargo test -p mish-bridge --test mihomo_activation \
  measures_pinned_core_private_candidate_home_activation_paths \
  -- --ignored --nocapture --test-threads=1
```

The pinned-Core samples used the binary produced by `pnpm prepare:mihomo` and
reported:

| Path                                     | Observed samples     |
| ---------------------------------------- | -------------------- |
| Cold activation from safe stop           | 3267.9 ms, 3676.8 ms |
| Warm replacement activation              | 3344.9 ms, 5161.7 ms |
| Relaunch after exact shutdown            | 3339.8 ms, 3292.2 ms |
| Validation failure plus rollback cleanup | 2146.3 ms, 2098.7 ms |
| Pre-cancelled preparation plus cleanup   | 2071.4 ms, 2087.7 ms |

“Cold” here means no active candidate or Core, not a privileged
operating-system page-cache purge. The separate first-sample and warm file
results prevent that limitation from being hidden.

The current 46.7 ms median file preparation is about 1.4% of the lower observed
3.27 s pinned cold activation. Eliminating the entire file stage—not merely its
write portion—cannot reach a 10% end-to-end improvement. The clone prototype
also regressed both median and tail. The complexity therefore buys no material
launch improvement.

## Alternatives rejected

### Persistent per-Profile home

Rejected because Profile revision and effective fingerprint are not the full
mutable-file identity. Runtime selection state, GeoData recovery, and
Profile-defined provider resources can outlive or contaminate a later
candidate. Cleaning those paths requires knowledge that is intentionally owned
by Mihomo and the Profile configuration.

### Persistent effective-fingerprint home

Rejected for the same mutable-state reason. The fingerprint scopes generated
Profile meaning and the selection cache, not every file Mihomo or a provider
may create. Reusing a root would also make cancellation and rejected-validation
cleanup distinguish reusable state from partial authority.

### APFS clone with sequential fallback

Rejected as production work for this issue. Copy-on-write regular files can
preserve candidate isolation, but per-activation verification remains required,
the measured prototype is slower, the portable path is slower, and even the
impossible zero-copy upper bound is below the materiality threshold. The
platform Seam and failure states would add Interface complexity without
leverage.

## Regression evidence

The deterministic `mihomo_activation` suite remains the test surface for the
deep activation Module. It covers validation failure, cancellation, shutdown,
relaunch, duplicate/concurrent activation, Core replacement and retirement,
post-promotion state-commit failure, stale ownership recovery, listener
readiness, and rollback. Candidate cleanup unit tests cover stale UUID roots,
partial staging, and a promoted path that fails before guard disarm. The file
harness separately injects partial-copy failure and cancellation and asserts
that no staging or candidate directory survives.

Because the isolation Seam is unchanged, these are characterization and
measurement regressions rather than a new storage implementation.
