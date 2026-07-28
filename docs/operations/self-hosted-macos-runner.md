# Self-hosted macOS CI runner

Mish runs all current GitHub Actions jobs on one repository-level Apple
Silicon runner. This is an availability response to hosted jobs failing before
runner allocation under the private-repository spending limit. It is not a
general permission to execute external contributions on a personal machine.

The production identity is:

| Property           | Required value                                        |
| ------------------ | ----------------------------------------------------- |
| GitHub runner name | `mish-macos-arm64-01`                                 |
| macOS account      | `mish-ci`                                             |
| Labels             | `self-hosted`, `macOS`, `ARM64`, `mish`, `trusted-ci` |
| Runner directory   | `/Users/mish-ci/actions-runner`                       |
| Hook directory     | `/Users/mish-ci/.local/share/mish-runner-hooks`       |
| Concurrency key    | `mish-self-hosted-ci`                                 |

The runner is repository-level, so it is available only to `Asuka109/mish`.
The additional `trusted-ci` label prevents the older `asuk-mini` registration
from accepting migrated jobs during setup or rollback.

## Threat model and routing

The machine is persistent and therefore is not a clean security boundary
between jobs. Mish compensates with a closed trigger set, a dedicated account,
full-SHA action pins, read-only tokens, serialized execution, outside-workspace
hooks, and complete workspace disposal.

The PR gate deliberately uses `pull_request_target` so GitHub loads the
workflow definition from reviewed `main`. It runs candidate code only when the
actor ID is the repository owner, both base and head repository IDs are the
immutable Mish ID, the head repository name is exact, the base is `main`, and
checkout selects `github.event.pull_request.head.sha`. Forks, Dependabot,
another actor, a merge ref, another base, a modified workflow definition, or
an indirect event cannot allocate the runner. The token is `contents: read`,
checkout never persists it, no secret or OIDC permission exists, and the PR
job neither restores a main-scoped dependency cache nor uploads an artifact.

Push jobs accept only owner-triggered `refs/heads/main`. Scheduled and manual
jobs use the exact default-branch workflow; manual jobs additionally require
the owner and matching triggering actor. The release-candidate workflow
retains its stricter frozen-main/source/tooling checks. Protected signing,
notarization, attestation, publication, and deployment remain disabled and
must not use this persistent runner.

If external contribution opens later, disable the PR self-hosted route before
accepting it. Restore an untrusted GitHub-hosted Linux lane or an ephemeral
single-job runner; do not broaden the actor/repository guard.

## Complete job matrix

| Workflow / job                               | Trigger and source                                            | Classification                                          | Token, cache, artifact, timeout                                                         |
| -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| CI / Fast PR gate                            | Owner-only same-repository PR head; reviewed default workflow | Redesigned, then trusted self-hosted                    | `contents: read`; no remote pnpm cache; no artifact; 10 min                             |
| CI / Inspect main                            | Daily schedule or owner manual; exact `main`                  | Trusted self-hosted                                     | `contents: read`; lockfile pnpm and `main-inspection` Rust caches; no artifact; 45 min  |
| CI / Package macOS ARM64                     | Owner push to `main` or owner manual packages/all             | Trusted self-hosted                                     | `contents: read`; lockfile pnpm and `macos-package` Rust caches; 14-day app ZIP; 45 min |
| CI / Package Android test APKs               | Owner push to `main` or owner manual packages/all             | Trusted self-hosted                                     | `contents: read`; pnpm, Gradle, and `android-package` Rust caches; 14-day APKs; 45 min  |
| Release / Freeze reviewed source and tooling | Owner manual dispatch on exact `main`                         | Trusted self-hosted                                     | `contents: read`; no cache/artifact; 10 min                                             |
| Release / Build Alpha candidate              | Frozen reachable source and frozen tooling                    | Trusted self-hosted, credential-free candidate          | pnpm/Rust caches; one-day immutable artifact; 60 min                                    |
| Release / Verify Alpha candidate             | Depends on exact candidate artifact ID                        | Trusted self-hosted                                     | no dependency cache; no new artifact; 10 min                                            |
| Release / Build Internal TUN candidate       | Source must equal frozen `main`                               | Trusted self-hosted, credential-free internal candidate | pnpm cache; one-day immutable artifact; 90 min                                          |
| Release / Verify Internal TUN candidate      | Exact candidate artifact ID, read-only DMG mount              | Trusted self-hosted                                     | no dependency cache; one-day verification evidence; 20 min                              |
| Release / Stage Internal TUN Alpha           | Exact candidate and verification artifact IDs                 | Trusted self-hosted                                     | no dependency cache; non-overwriting 14-day stage; 10 min                               |
| Release / Confirm Internal TUN stage         | Exact final artifact ID, read-only DMG mount                  | Trusted self-hosted                                     | no dependency cache/new artifact; 20 min                                                |
| Release / Verify signed-direct plan          | Frozen source; protected execution disabled                   | Trusted self-hosted, fixture-only                       | pnpm/Rust caches; no artifact; 60 min                                                   |

Every third-party action is allowlisted in
`.github/trusted-release-policy.json` and pinned to a full commit SHA.
Repository Actions settings must use `allowed_actions: selected` and require
full-SHA pins. No current workflow reads a repository or Environment secret.

## Account and host prerequisites

Create `mish-ci` in System Settings as a **Standard** user. It must have no
administrator membership, Apple Account, SSH keys, GitHub CLI login, FileVault
unlock authority, copied shell dotfiles, Developer ID identity, notarization
credential, personal Keychain item, network share credential, or access to the
interactive user's home. Do not enable Remote Login for it.

Install current macOS security updates and Xcode Command Line Tools. The
workflow pins Node `24.10.0`, pnpm `11.13.1`, Temurin 17, Android command-line
tools `14742923`, API 36, Build Tools `36.1.0`, NDK `29.0.14206865`, and the
Rust `1.97.1` toolchain plus Clippy, rustfmt, and both Android targets.
`rust-toolchain.toml`, setup actions, the Gradle wrapper, and lockfiles are the
authority; undocumented global versions are not.

The macOS runner service is a per-user LaunchAgent. Log into `mish-ci` once
after boot, start the service, then use Fast User Switching back to the normal
interactive account. Never leave `mish-ci` as `/dev/console`; the first job
step and pre-job hook reject that state so CI cannot open windows or steal
focus.

## Install and register

1. In repository **Settings → Actions → Runners**, remove the old runner only
   after its local service is stopped. Download the current Apple Silicon
   runner archive using GitHub's displayed URL and verify the displayed
   SHA-256 before extracting it into `~/actions-runner`.
2. From a clean checkout of the reviewed delivery commit, install the three
   hook files outside the runner application directory:

   ```sh
   install -d -m 700 "$HOME/.local/share/mish-runner-hooks"
   install -m 700 scripts/self-hosted-runner-hygiene.sh \
     scripts/self-hosted-runner-job-started.sh \
     scripts/self-hosted-runner-job-completed.sh \
     "$HOME/.local/share/mish-runner-hooks/"
   ```

3. Register with the time-limited repository token pasted into a silent shell
   variable. Never put the token in a file, command history, log, issue, PR, or
   support bundle:

   ```sh
   cd "$HOME/actions-runner"
   read -rs RUNNER_TOKEN
   ./config.sh \
     --url https://github.com/Asuka109/mish \
     --token "$RUNNER_TOKEN" \
     --name mish-macos-arm64-01 \
     --labels mish,trusted-ci \
     --work _work \
     --unattended
   unset RUNNER_TOKEN
   ```

4. Add these exact lines to `~/actions-runner/.env` and mode it `0600`:

   ```text
   MISH_RUNNER_USER=mish-ci
   MISH_RUNNER_ROOT=/Users/mish-ci/actions-runner
   MISH_RUNNER_HOOK_ROOT=/Users/mish-ci/.local/share/mish-runner-hooks
   ACTIONS_RUNNER_HOOK_JOB_STARTED=/Users/mish-ci/.local/share/mish-runner-hooks/self-hosted-runner-job-started.sh
   ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/Users/mish-ci/.local/share/mish-runner-hooks/self-hosted-runner-job-completed.sh
   PATH=/opt/homebrew/bin:/Users/mish-ci/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin
   ```

5. Install and start the LaunchAgent:

   ```sh
   cd "$HOME/actions-runner"
   ./svc.sh install
   ./svc.sh start
   ./svc.sh status
   ```

The runner must appear online with the exact name and five labels before any
workflow is dispatched. Registration tokens are time-limited bootstrap data;
the configured runner credential remains only in the runner directory.

## Hygiene and failure recovery

GitHub invokes the installed pre/post hooks synchronously outside the checkout.
Both verify the dedicated user, Apple Silicon, exact runner/hook roots, and an
inactive runner desktop. They terminate only an explicit process allowlist for
the dedicated UID, detach only disk images whose backing file is inside the
runner work root, delete only runner-created temporary Keychains, and empty
only `/Users/mish-ci/actions-runner/_work`. DMG detach uses five normal retries
and never force-detaches. A cleanup failure fails the job.

The post hook handles ordinary success, failure, and cancellation. If a crash,
power loss, runner update, or forced termination prevents it, the next pre-hook
performs the same cleanup before source checkout. The workflow default uses
headless DMG creation and `hdiutil attach -readonly -nobrowse -noautoopen`;
Finder styling remains an explicit local-only command.

After reboot, log into `mish-ci`, switch away, and verify `./svc.sh status`.
After a runner auto-update, rerun the identity/hook smoke job. If the runner is
suspected compromised, stop it immediately, remove its GitHub registration,
preserve `_diag` only for private incident review, delete the dedicated account
and runner directory through the macOS account-removal flow, then reinstall
from a verified archive. There are no CI secrets to rotate; rotate any
credential found on the account because its presence violates this contract.

## Offline behavior, rollback, and a second runner

There is intentionally no hosted fallback. GitHub queues an exact-label job
while the Mac mini is offline and eventually expires it; it must not silently
execute on a broader runner. Current private-plan settings cannot enforce a
required branch check, so the owner must treat a missing Fast PR gate as a stop
condition rather than merge around it. To recover, start/restart the runner or
manually dispatch the exact `main` inspection/packages task after service
recovery.

Rollback order is:

1. Disable or revert self-hosted workflow routing on `main`.
2. Confirm no queued job still targets `trusted-ci`.
3. Stop and uninstall the LaunchAgent with `./svc.sh stop` and
   `./svc.sh uninstall`.
4. Generate a time-limited removal token in repository Settings, run
   `./config.sh remove --token "$RUNNER_TOKEN"` through a silent variable, and
   confirm the runner disappears from GitHub.
5. Remove the dedicated macOS account and its home through System Settings.

Because no branch rule can currently require these checks, unregistering does
not strand a server-enforced required check. It does remove all workable CI
capacity until another exact-label runner or hosted funding is restored.

A future second runner uses a new identity such as
`mish-macos-arm64-02`, the same dedicated-account contract, and the same
labels. The shared concurrency key deliberately prevents parallel jobs today.
Remove or split that lock only after jobs have separate accounts/workspaces and
tests prove that Keychains, DMGs, Android SDK state, Cargo targets, browser
processes, and package outputs cannot collide.

## Hands-on acceptance

Evidence is complete only after all of these are observed on the real Mac mini:

- exact runner identity and labels online;
- an owner same-repository PR head is accepted, while a fork/other actor is
  skipped before allocation;
- a `main` or owner-manual package/inspection job is picked up;
- success, deliberate failure, and cancellation each show both hook phases and
  leave no workspace, leaked process, temporary Keychain, or runner-owned DMG;
- two queued jobs serialize;
- reboot/login/Fast User Switching restores the service;
- no Finder window opens and focus remains with the interactive account;
- logs and artifacts contain no token, secret, or personal account path;
- stop/unregister and re-register recover without a stranded required check.

GitHub documents that self-hosted runners are persistent, repository-level
runners are dedicated to one repository, job hooks execute before/after each
job, and jobs with unavailable labels can remain queued. See
[self-hosted runner concepts](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners),
[runner hooks](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts),
[service configuration](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application-as-a-service),
and [runner removal](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/remove-runners).
