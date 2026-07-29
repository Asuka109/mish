# Self-hosted macOS CI runner

Mish runs all current GitHub Actions jobs on one repository-level Apple
Silicon runner. This is an availability response to hosted jobs failing before
runner allocation under the private-repository spending limit. It is not a
general permission to execute external contributions on a personal machine.

The production identity is:

| Property           | Required value                                        |
| ------------------ | ----------------------------------------------------- |
| GitHub runner name | `asuk-mini`                                           |
| macOS account      | Existing non-root Mac mini login; trusted code only   |
| Labels             | `self-hosted`, `macOS`, `ARM64`, `mish`, `trusted-ci` |
| Runner directory   | `~/actions-runner/mish`                               |
| Hook directory     | `~/.local/share/mish-runner-hooks`                    |
| Concurrency key    | `mish-self-hosted-ci`                                 |

The runner is repository-level, so it is available only to `Asuka109/mish`.
The `trusted-ci` label was added to the existing `asuk-mini` registration only
after its identity, Apple Silicon architecture, repository scope, runner root,
loaded LaunchAgent, and prior successful Mish run were confirmed.

## Threat model and routing

The machine is persistent and therefore is not a clean security boundary
between jobs. The existing registration also runs under the current console
account. That exception is acceptable only while all executable workflow
sources are owned and reviewed by the sole repository owner and no external
contribution is accepted. Mish compensates with a closed trigger set, an exact
runner identity, full-SHA action pins, read-only tokens, serialized execution,
outside-workspace hooks, and runner-workspace disposal.

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
accepting it. Restore an untrusted GitHub-hosted Linux lane, an ephemeral
single-job runner, or a dedicated standard macOS account; do not broaden the
actor/repository guard while using the console account.

## Job matrix

| Lane                       | Trusted source and use                                | Cache / output                                                |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| PR gate                    | Owner-only same-repository head via reviewed workflow | No restored dependency cache or artifact; 10-minute ceiling   |
| Main inspection            | Daily or owner-manual exact `main`                    | Lockfile-keyed pnpm/Rust cache; no artifact; 45 minutes       |
| macOS/Android test package | Owner push or manual exact `main`                     | Scoped caches and 14-day non-production artifacts             |
| Release-candidate checks   | Owner-manual frozen `main`, source, and tooling       | Credential-free immutable artifacts only; protected paths off |

Every third-party action is allowlisted in
`.github/trusted-release-policy.json` and pinned to a full commit SHA.
Repository Actions settings must use `allowed_actions: selected` and require
full-SHA pins. No current workflow reads a repository or Environment secret.

## Host prerequisites

The existing runner uses the current non-root console account. Until it moves
to a dedicated Standard account, run only owner-authored code, avoid
interactive development during CI, and keep personal credentials, mounted
shares, and files outside the runner work tree out of workflows. Cleanup is
workspace-scoped and never kills every process for the account or deletes
unrelated files. Routine verification is headless: no Finder, AppleScript, or
GUI application.

Keep macOS and Xcode Command Line Tools current. Workflow/setup files pin Node,
pnpm, Temurin, Android tools/targets, Rust `1.97.1`, Clippy, and rustfmt; the
Gradle wrapper and lockfiles are authoritative. The per-user LaunchAgent must
recover after login/reboot.

## Reuse and configure the existing registration

1. Confirm repository **Settings → Actions → Runners** shows `asuk-mini`
   online with `self-hosted`, `macOS`, `ARM64`, `mish`, and `trusted-ci`.
   Do not create a duplicate registration.
2. From a clean checkout of the reviewed delivery commit, install the three
   hook files outside the runner application directory:

   ```sh
   install -d -m 700 "$HOME/.local/share/mish-runner-hooks"
   install -m 700 scripts/self-hosted-runner-hygiene.sh \
     scripts/self-hosted-runner-job-started.sh \
     scripts/self-hosted-runner-job-completed.sh \
     "$HOME/.local/share/mish-runner-hooks/"
   ```

3. Update `~/actions-runner/mish/.env` without printing its existing content.
   Resolve paths at write time; literal `~` is not valid in runner hook
   variables:

   ```sh
   runner_root="$HOME/actions-runner/mish"
   hook_root="$HOME/.local/share/mish-runner-hooks"
   env_file="$runner_root/.env"
   env_next="$runner_root/.env.mish-next"
   grep -Ev '^(MISH_RUNNER_ROOT|MISH_RUNNER_HOOK_ROOT|ACTIONS_RUNNER_HOOK_JOB_STARTED|ACTIONS_RUNNER_HOOK_JOB_COMPLETED)=' \
     "$env_file" > "$env_next"
   {
     printf 'MISH_RUNNER_ROOT=%s\n' "$runner_root"
     printf 'MISH_RUNNER_HOOK_ROOT=%s\n' "$hook_root"
     printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s/self-hosted-runner-job-started.sh\n' "$hook_root"
     printf 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=%s/self-hosted-runner-job-completed.sh\n' "$hook_root"
   } >> "$env_next"
   chmod 600 "$env_next"
   mv "$env_next" "$env_file"
   ```

4. Restart and verify the existing LaunchAgent:

   ```sh
   cd "$HOME/actions-runner/mish"
   ./svc.sh stop
   ./svc.sh start
   ./svc.sh status
   ```

The runner must return online with the exact name and five labels. No
registration token is needed for this reuse path. If recovery ever requires
re-registration, use a time-limited token through a silent variable; never put
it in a file, command history, log, issue, PR, or support bundle.

## Hygiene and failure recovery

GitHub invokes the installed pre/post hooks synchronously outside the checkout.
Both verify a non-root user, Apple Silicon, exact runner/hook roots, and runner
directory ownership. They terminate only processes whose current directory is
inside `~/actions-runner/mish/_work`, excluding the hook and its ancestors.
They detach only disk images whose backing file is inside that work root,
delete only runner-created temporary Keychains, and empty only the repository,
downloaded-action, and temporary subdirectories below the work root. DMG
detach uses five normal retries and never force-detaches. A cleanup failure
fails the job.

The post hook handles ordinary success, failure, and cancellation. If a crash,
power loss, runner update, or forced termination prevents it, the next pre-hook
performs the same cleanup before source checkout. The workflow default uses
headless DMG creation and `hdiutil attach -readonly -nobrowse -noautoopen`;
Finder styling remains an explicit local-only command.

After reboot and login, verify `./svc.sh status`. After a runner auto-update,
rerun the identity/hook smoke job. If the runner is
suspected compromised, stop it immediately, remove its GitHub registration,
preserve `_diag` only for private incident review, move the replacement to a
fresh dedicated Standard account, and reinstall from a verified archive.
Because this runner shares the console account, rotate any personal credential
that evidence shows the job accessed.

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
5. Remove the `trusted-ci` label and the installed Mish hook files; preserve
   the console account and unrelated personal files.

Because no branch rule can currently require these checks, unregistering does
not strand a server-enforced required check. It does remove all workable CI
capacity until another exact-label runner or hosted funding is restored.

A future second runner uses a new identity such as
`mish-macos-arm64-02`, a dedicated Standard account, and the same
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
- reboot/login restores the service;
- no Finder window opens and focus remains with the interactive account;
- logs and artifacts contain no token, secret, or personal account path;
- stop/unregister and re-register recover without a stranded required check.

## Recorded validation evidence

The migration branch exercised the existing runner before removing its
branch-only probe workflow:

| Evidence                                                | GitHub Actions run(s)        | Result                                                                 |
| ------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| Historical direct routing to `asuk-mini`                | `29719595322`                | Fast PR gate passed on the existing runner                             |
| Exact identity, labels, architecture, root, and tooling | `30376512454`, `30376584783` | Passed without reading credentials                                     |
| Hook repair and workspace-scoped cleanup                | `30380072393`, `30380137147` | Pre/post hooks, checkout, leaked-process kill, and DMG detach passed   |
| Deliberate job failure                                  | `30380194662`                | Job failed with the test exit code; checkout post and runner post pass |
| Deliberate cancellation                                 | `30380243023`                | Cancellation completed; checkout post and runner post pass             |
| Serialized concurrent scheduling                        | `30380361967`, `30380400762` | First run was active while the second remained pending                 |
| Final-shape PR gate and headless macOS bundle           | `30380564386`                | All steps passed in 4 minutes 8 seconds                                |

The LaunchAgent was stopped while loading hooks, remained offline instead of
silently falling back to a hosted runner, then recovered through the existing
`svc.sh start` path and immediately accepted the queued trusted job. An actual
macOS reboot remains a hands-on acceptance item.

GitHub's own runner/action logs print the absolute runner working directory,
which includes the local account name. For this private repository and reused
console-account registration, that automatically emitted runner path is the
accepted local-path disclosure boundary. Mish scripts must not print any
additional personal path, credential path, token, secret, Keychain content, or
mounted-share path. Artifacts must contain none of them.

GitHub documents that self-hosted runners are persistent, repository-level
runners are dedicated to one repository, job hooks execute before/after each
job, and jobs with unavailable labels can remain queued. See
[self-hosted runner concepts](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners),
[runner hooks](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts),
[service configuration](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application-as-a-service),
and [runner removal](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/remove-runners).
