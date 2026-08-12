# Trusted CI, Signing, and Publication Boundary

Mish currently has no executable trusted signing, notarization, attestation,
publication, release, or deployment job. This is an intentional fail-closed
state, not evidence that a protected gate ran successfully.

Protected execution remains disabled until branch/ruleset review,
reviewer-protected Environments, the selected Action allowlist, full-SHA
pinning, and the OIDC subject all match the checked-in policy. No production
secret or signing identity may be configured while that flag is false.

The latest reviewed hosted `main` run for
`d925f0abd09c1f153cc54f2e2bcea054b6477b1e`
([CI run 31294286763](https://github.com/Asuka109/mish/actions/runs/31294286763))
completed its macOS ARM64 and Android packaging jobs with 15 and 20 executed
steps. Credential-free Internal TUN Alpha
[staging run 31296492082](https://github.com/Asuka109/mish/actions/runs/31296492082)
also completed its candidate, independent verification, final binding, and
fresh-runner confirmation jobs. These are runner-executed packaging and private
staging evidence, not a protected production signing or publication gate.

The live trust-settings audit remains `disabled-fail-closed`: required
main-branch review and CODEOWNERS enforcement are unavailable, the protected
signing/publication Environments do not exist, and OIDC does not bind the exact
workflow identity. No production credential or signing identity may be added
or inferred from the successful credential-free runs.

## CI drift and external-check evidence boundary

The checked-in CI validators are repository evidence only. `check:ci` discovers
every workflow file, validates every job and action reference, and requires the
reviewed CI job and platform-target inventories to stay explicit. A passing
offline fixture proves that the checked-in parser would reject an added,
deleted, renamed, unsupported, or bypass-shaped workflow/job/action/target
entry; it does not prove that GitHub branch protection requires the resulting
check.

The trusted policy names `CI / Fast PR gate` and `CI / Android platform Rust
gate` as required pull-request status checks. `pnpm audit:ci:trust-settings` is
the only check in this repository that reads that server-side fact. It is
read-only and accepts either an exact classic branch-protection response or an
active main-branch ruleset with the reviewed required-check contexts. A missing,
unavailable, partial, or mismatched branch-protection/ruleset response fails
closed; a successful workflow run, a local fixture, or an external provider's
dashboard cannot substitute for this read-back. The audit never creates,
updates, or deletes branch protection, rulesets, Environments, OIDC settings,
runners, or external checks.

## Threat model

The boundary treats pull-request code, fork code, merge refs, arbitrary refs,
workflow inputs, cached state, uploaded artifacts, reusable-workflow callers,
and runner state as untrusted. A malicious contribution must not be able to:

- read a repository or Environment secret;
- mint a trusted OIDC identity;
- run on a maintainer workstation or signer;
- select protected tooling or a protected workflow revision;
- substitute a source commit, artifact, SBOM, provenance statement, or digest;
- invoke a privileged reusable workflow with attacker-controlled inputs; or
- create a tag, Release, attestation, deployment, or Mish-signed artifact.

Routine PR validation runs on isolated GitHub-hosted `ubuntu-24.04`; the
Android lifecycle instrumentation gate uses isolated GitHub-hosted `macos-15`
so its ARM64 emulator can use the platform hypervisor without root. Every PR
job has only `contents: read`. They do not use a self-hosted runner, secret,
OIDC token, reusable workflow, or artifact upload.

## Current executable workflow

`Validate macOS Release Candidate` is manual and credential-free. GitHub
evaluates its source-freeze job condition before allocating a runner. The
condition fixes:

- repository name, immutable repository ID, and owner ID;
- `workflow_dispatch` on `refs/heads/main`;
- the maintainer actor and matching triggering actor;
- the exact workflow path on `refs/heads/main`; and
- `github.workflow_sha == github.sha`.

The first checkout uses `github.workflow_sha`, fetches complete `main` history,
does not persist the token, and proves that local `HEAD` and `origin/main`
equal that workflow SHA. An optional source must be a full commit SHA reachable
from the frozen main SHA. All later jobs check out the exact source and an
isolated `.release-tooling` tree at the workflow SHA.

The Alpha build is still untrusted. It executes candidate source only on a
GitHub-hosted runner with `contents: read`, then writes a deterministic
candidate manifest. The manifest binds repository, actor, event, ref, run,
source SHA, main SHA, workflow SHA, tooling SHA, every relative file name,
role, byte count, SHA-256, and the canonical whole-set SHA-256. Upload uses
one-day retention. The read-only decision job downloads by immutable artifact
ID, rejects symlinks, missing or unexpected files, digest drift, identity
drift, and artifact-name drift, and then reports explicitly that the candidate
is not a project-trusted release.

The signed-direct branch runs only repository validation and credential-free
policy, updater, and adversarial fixtures. There is no job with an Environment,
secret reference, write permission, OIDC permission, signing command,
attestation command, tag/Release mutation, or deployment command.

The `internal-tun-alpha` branch is a credential-free private artifact staging
lane, not protected signing or release publication. It requires source, frozen
`main`, workflow, and tooling to be the same full SHA. One isolated
GitHub-hosted Apple Silicon job builds the ad-hoc package, reviewed Finder DMG,
SPDX SBOM, in-toto/SLSA provenance, and complete candidate manifest. A separate
Apple Silicon job downloads only that immutable artifact ID and mounts the DMG
read-only for independent verification. A secretless Ubuntu job binds the
candidate and verification artifact IDs into a final non-overwriting 14-day
stage, and a fresh Apple Silicon job reverifies the final artifact ID before
writing any successful summary.

The final manifest binds repository/actor/event/ref/run identity, source and
workflow/tooling SHA, profile/version, Helper/Core/plist digests and versions,
installation-identity inputs, protocol, `Cargo.lock`, `pnpm-lock.yaml`,
`skills-lock.json`, relevant source/tooling inputs, SBOM, provenance,
verification evidence, and DMG SHA-256. Partial, duplicate-role, stale,
substituted, unexpected, missing, or mismatched input fails closed.
`overwrite: false` and a run-bound artifact name prevent a later dispatch from
replacing an existing immutable stage.

This lane retains only `contents: read` repository permission. It receives no
secret, OIDC token, protected Environment, self-hosted runner, Apple credential,
tag/Release mutation, or deployment permission. Its ad-hoc DMG remains private
Internal TUN Alpha material and cannot become project-trusted or public release
evidence. Billing or runner allocation failure produces no final artifact and
must not be reported as successful staging.

## Future activation prerequisites

Live protected jobs may be added only in one reviewed change after every item
below is observed through `pnpm audit:ci:trust-settings`:

1. Confirm GitHub exposes protected branches/rulesets and
   reviewer-protected Environments for the repository.
2. Protect `main`; require the Fast PR gate, approving review, and CODEOWNERS
   review; dismiss stale approvals; require conversation resolution; prohibit
   force pushes and deletion; and prevent an administrator bypass.
3. Configure `macos-developer-id` and `release-publication` with selected
   `main` only, required reviewer `18379948`, and no administrator bypass.
   Store signer inputs only in `macos-developer-id`; the publication
   Environment must not receive Apple credentials.
4. Preserve the explicit repository Action allowlist and full-commit-SHA
   requirement. The checked-in workflows and live audit both verify the exact
   reviewed third-party SHAs.
5. Configure OIDC only if a protected service requires it. Its subject and
   provider trust policy must bind repository and owner IDs, event, main ref,
   exact workflow and reusable-workflow paths and SHAs, Environment, actor ID,
   run ID, and run attempt. A broad repository-only subject is insufficient.
6. Keep untrusted and protected jobs on GitHub-hosted images.
7. Keep protected reusable workflows disabled unless a caller and callee are
   both pinned by full commit SHA and the callee independently validates every
   input. `secrets: inherit`, branch/tag references, arbitrary callers, and
   caller-supplied commands or paths are forbidden.

`.github/CODEOWNERS` already requests `@Asuka109` review for workflows, trust
policy, release/updater tooling, packaging configuration, entitlements,
documentation, package commands, and the ownership map itself. On the current
plan this is review routing, not enforceable required review; the activation
flag must remain false until server-side review enforcement is observed.

## Future protected data flow

A later signer must use two distinct phases:

1. An unprivileged GitHub-hosted build receives no secret, write token, OIDC
   token, protected Environment, or signer runner. It builds the exact frozen
   source, emits an unsigned application, SBOM, and build provenance, creates
   the complete manifest, uploads once, and records the immutable artifact ID.
2. A protected signer defined by the reviewed main workflow depends on an
   independent trust-verification job. The signer rechecks repository, event,
   actor, ref, workflow SHA, tooling SHA, source ancestry, manifest, immutable
   artifact ID, provenance subject, SBOM subject, and complete file set before
   the first secret-consuming step. It never checks out or executes candidate
   source. It signs only the verified unsigned payload with frozen tooling.

Signing and notarization evidence must then bind the same source, workflow,
tooling, unsigned digest, signed digest, SBOM, provenance, identity, ticket,
and assessment results. A separate `release-publication` approval must
redownload by immutable artifact ID, verify GitHub attestations with the exact
signer workflow identity, recheck all local digests and expected file names,
and create only the immutable tag and Draft Pre-release selected by policy.
Publication must never rebuild or modify the candidate.

Updater signing and any future Developer-ID-bearing TUN artifact follow the
protected flow but require their own exact roles and identities. Neither is
activated or staged here. The credential-free Internal TUN Alpha lane above
does not cross that production boundary.

## Deterministic verification

Run:

```sh
pnpm check:trusted-ci
pnpm release:trusted-boundary:fixture
pnpm test:macos:release
pnpm test:macos:signed-release
pnpm check:macos:release-workflow
pnpm audit:ci:trust-settings
```

The adversarial fixture rejects fork repositories, PR events, merge refs,
untrusted actors, workflow/tooling drift, non-ancestor source SHAs, self-hosted
runners, reusable-workflow callers, disabled protected execution, artifact
substitution, unexpected files, invalid immutable artifact IDs, and symlinks.
It also rejects hard links, excessive directory depth or file count, and an
oversized manifest. The live settings audit is read-only. While controls are
unavailable it returns `disabled-fail-closed`; enabling protected execution
with any blocker changes that result to `unsafe` and fails.

The Internal TUN staging fixtures additionally reject an ancestor that is not
the frozen `main` SHA, version/profile drift, duplicate roles, missing
verification, changed DMG bytes, stale candidate identity, unexpected files,
and attempts to replace an existing final stage.

## GitHub platform references

- [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
  — full commit SHA action pinning and untrusted-code guidance.
- [Deployments and Environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
  — required reviewers, branch/tag restrictions, and secret availability.
- [Contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)
  — `workflow_ref`, `workflow_sha`, actor, repository, run, and ref identities.
- [OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
  — reusable-workflow and custom subject claims.
- [Artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
  — provenance and SBOM subjects and verification.
