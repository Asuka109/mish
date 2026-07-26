# macOS Packaging and Signing

Mish produces one Apple Silicon test package from pushes to `main`. Pull
requests run the bounded `check:pr` gate but never build or upload an app
archive. Daily and manual inspection own complete validation. Packaging remains
independent, so a failed application build cannot reach artifact upload.

The latest `cbe281c` package run did not start either hosted package job because
the private repository's Actions quota or billing state blocked them. This
leaves current CI artifact evidence unavailable; it is not evidence of a product
implementation failure and does not establish future Actions capacity.

## Alpha ad-hoc DMG

Build the explicit System Proxy-only Alpha artifact on Apple Silicon macOS:

```sh
pnpm install --frozen-lockfile
pnpm desktop:bundle:macos
```

This credential-free profile rejects Apple signing and notarization credentials,
builds an ARM64 `Mish` DMG without opening or foregrounding Finder, and mounts it
read-only for verification. This headless command is the default for CI and
ordinary repeated local verification. The mounted image contains only `Mish.app`
and an `Applications` shortcut for drag-to-install.
It seals the application and Mihomo with an ad-hoc signature, packages no TUN
helper, LaunchDaemon, SMAppService payload, development helper, or other
privileged content, and compiles the packaged TUN capability as unavailable.
The verifier checks the application identifier, version, architecture, pinned
Mihomo digest and version, offline Web resources, legal resources, signature
structure, DMG layout, and clean detach.

### Packaged WebView Inspector

Packaged macOS builds retain an explicit, process-local WebView Inspector
opt-in. Launch the installed executable directly with either form:

```sh
"/Applications/Mish.app/Contents/MacOS/mish-desktop" --devtools

MISH_DEVTOOLS=1 "/Applications/Mish.app/Contents/MacOS/mish-desktop"
```

The command-line flag takes precedence over the environment. Without it,
`MISH_DEVTOOLS` accepts exactly `1` or `0`; malformed values stop startup with
the Inspector disabled. An ordinary Finder, Dock, Login Item, `open -a Mish`,
or direct executable launch without either opt-in has no Web Inspector
affordance. Quit Mish before testing the next form because the managed-runtime
lease permits only one operational desktop process.

The opt-in uses Tauri's local WebKit Inspector surface and does not open a
remote-debugging port or network listener. It affects only Mish's main desktop
WebView, not the standalone Browser Client, and does not change bridge
authentication, CSP, or RPC authorization. The Tauri API uses a macOS private
WebKit surface and is not compatible with a Mac App Store build; a requested
unsupported platform returns a bounded startup diagnostic instead of claiming
the Inspector is enabled.

> **Sensitive diagnostic warning:** The Inspector can reveal local application
> state, tokens, authenticated bridge payloads, Profile-derived data, network
> activity, and other sensitive diagnostics. Do not share screenshots, exports,
> or copied values without reviewing and redacting them.

After an Inspector session, quit Mish and launch it normally:

```sh
"/Applications/Mish.app/Contents/MacOS/mish-desktop"
```

The later process must start with the Inspector closed because the opt-in is
never persisted in Settings or application storage.

Use the Finder-styled path only when intentionally preparing a delivery image:

```sh
pnpm desktop:bundle:macos:styled
```

That explicit command permits Tauri's Finder AppleScript to arrange the mounted
image. Both commands still use bounded ordinary detach and never force-detach or
leave a verifier mount behind.

An ad-hoc signature is neither an Apple identity nor notarization. Gatekeeper
rejection or **Open Anyway** is the expected Alpha boundary; do not describe the
DMG as trusted or notarized. This profile does not install a helper, request
administrator authorization, or modify host network state.

## Signed-direct Stage 1 profile

`signed-direct` is the explicit future Developer ID profile for the same
System Proxy-only application. It is never selected from the presence of a
certificate, identity, keychain, or notary input. The build entry point is:

```sh
pnpm desktop:bundle:signed-direct:macos
```

Do not run that command with a real identity outside the maintainer-owned,
reviewer-protected `macos-developer-id` GitHub Environment from Issue #171.
Ordinary Stage 1 repository verification defines and tests the input boundary
without provisioning, importing, or reading credentials. The protected
workflow executor imports the complete credential set into an ephemeral
keychain, verifies the one exact Developer ID identity, and gives the nested
build step only:

- `APPLE_SIGNING_IDENTITY`, containing an exact `Developer ID Application: … (TEAMID)` identity;
- `MISH_EXPECTED_APPLE_TEAM_IDENTIFIER`, matching that identity; and
- `MISH_PROTECTED_RELEASE_ENVIRONMENT=macos-developer-id`, asserting that the
  reviewer-protected boundary has already been crossed.

The build step rejects certificate payloads, passwords, notary keys, inherited
package modes, and raw `MISH_APPLE_*` inputs. Import and cleanup remain owned by
the protected workflow executor, not by general packaging code or pull-request
CI. The executor and an independent `always()` cleanup step both target the
same bounded runner-temporary directory. The keychain search list is restored,
the temporary keychain is locked and deleted, and temporary certificate and
notary-key material is removed before any candidate upload.

The profile signs the pinned Mihomo executable first with identifier
`com.asuka109.mish.mihomo`, then lets Tauri seal `Mish.app` with identifier
`com.asuka109.mish`. Both signatures require the hardened-runtime flag. The
reviewed minimum entitlement set is empty and is recorded explicitly in
`apps/desktop/src-tauri/Entitlements.signed-direct.plist`; this direct,
non-sandboxed System Proxy application currently requires no Apple entitlement.
Adding an entitlement is a policy change and fails the fixture contract.

The signed layout allows exactly the main executable and pinned Mihomo as
Mach-O code. It excludes every TUN helper, LaunchDaemon, SMAppService or XPC
payload, Login Item, development helper, and other privileged artifact.
Runtime capability is compiled from the explicit profile and reports TUN
unavailable; a signing team identifier alone cannot enable the production TUN
adapter.

The live verifier checks the exact Developer ID identity, team, identifiers,
hardened runtime, empty entitlements, nested-code order, and
`codesign --verify --deep --strict`. It also rejects unsigned or unexpected
nested code, symlinks, writable or hard-linked payloads, case/normalization
duplicates, privileged content, and a layout that advertises TUN. Credential-
free tests use synthetic identity evidence and prove this policy without
claiming Apple trust, notarization, or release readiness:

```sh
pnpm test:macos:bundle
pnpm desktop:bundle:fixture:signed-direct:macos
```

The second command builds the real System Proxy-only app layout, seals it
ad hoc, runs the packaged capability probe, applies synthetic Developer ID
identity evidence to the policy verifier, and proves that the actual bundle
does not satisfy the Apple Developer ID requirement. It is package-shape
evidence only.

Credential-free Stage 1 verification does not produce a live Developer ID
artifact, DMG, notarization submission, stapled ticket, Gatekeeper acceptance,
release, updater, Intel binary, or production TUN capability. The repository
contains an unexecuted real path for after #171: it creates a headless signed
DMG, submits that exact DMG with `notarytool`, requires an accepted terminal
result and issue-free log, staples and validates the ticket, reruns strict
Developer ID and disk-image Gatekeeper assessments, generates an SPDX 2.3 SBOM,
and binds GitHub provenance and SBOM attestations to the unchanged final DMG.
Any unsupported attestation capability or failed Apple/GitHub operation stops
before Draft staging.

## Draft release staging

The **Stage macOS Draft** Actions workflow is the manual staging boundary for an
already-versioned source commit. Its `Run workflow` form requires an explicit
`alpha-ad-hoc` or `signed-direct` profile; secret presence never chooses a
profile. It also requires a prerelease SemVer such as `0.1.0-alpha.1`, accepts
an optional full source SHA, and defaults to a read-only dry run. A blank source
freezes the current `main` commit. An explicit source must be one full commit
SHA reachable from that frozen `main`.

The prerelease base version must match all desktop version declarations in the
selected source. The workflow checks out that exact commit for every later job;
it never rebuilds a floating branch. Release tooling is independently frozen
from the same dispatch-time `main`, so an older reachable source can be staged
without borrowing application code from a later commit.

For `alpha-ad-hoc`, the selected source must preserve #168's
`pnpm desktop:bundle:macos` command. The workflow runs `pnpm check:all`,
preserves the existing Alpha build and read-only DMG inspection contract, then
generates the same deterministic candidate files:

- `Mish-<version>-arm64.dmg`
- `SHA256SUMS.txt`
- `release-metadata.json`

The metadata records the full source SHA, exact `v<version>` tag, ARM64
architecture, minimum macOS version, pinned Mihomo version, ad-hoc signing mode,
Draft Pre-release kind, and the expected
`rejection-or-app-scoped-open-anyway` Gatekeeper boundary. The checksum manifest
covers the DMG and metadata. The Alpha branch remains credential-free and keeps
the same source, build, candidate, permission, conflict, retry, and Draft-only
mutation contract as before profile selection was added.

For `signed-direct`, the default dry run stops after complete repository
validation and a credential-free plan. It verifies the trusted
`workflow_dispatch`/`main`/repository/permission boundary and reports that no
live Apple result was observed. Disabling dry run routes the next job through
the reviewer-protected `macos-developer-id` Environment. Missing approval means
the job never starts; an untrusted event, fork, profile drift, or any missing
credential fails before keychain creation or signing.

The protected executor records one ordered evidence chain: temporary keychain
creation and certificate import; exact identity verification; the existing
signed-direct bundle build and package verification; headless DMG creation;
notary submission and accepted terminal log; stapling and validation;
independent strict code-signing and Gatekeeper disk-image assessment; SBOM
generation; and temporary-material cleanup. A later credential-free job binds
GitHub provenance and SBOM attestations to that exact DMG, freezes the DMG,
SBOM, evidence, and attestation-bundle digests, and writes one checksum manifest
covering the complete candidate:

- `Mish-<version>-arm64.dmg`
- `macos-sbom.spdx.json`
- `signed-release-evidence.json`
- `provenance-attestation.sigstore.json`
- `sbom-attestation.sigstore.json`
- `SHA256SUMS.txt`

Only after the exact candidate uploads successfully can read-only staging
planning run. The signed Draft write job depends on protected execution,
cleanup, both attestations, final digest verification, candidate upload, and
the read-only decision. A missing ticket, Apple rejection, assessment failure,
attestation or upload failure, changed artifact, changed checksum, conflicting
tag, or non-Draft remote state stops the workflow. It never moves an existing
tag or publishes a Release.

All source, validation, build, and decision jobs retain `contents: read`.
GitHub attestation receives only the narrowly required OIDC and attestation
permissions. Only the final profile-specific staging job has `contents: write`.
The workflow is manual-only, has no pull-request or fork trigger, scopes
concurrency by profile and version, and never cancels another candidate.
Publishing either Draft remains a separate human action.

Run the local deterministic decisions, tests, and workflow contract without
reading secrets, contacting Apple, creating a tag, or creating a Release:

```sh
pnpm release:macos:fixture
pnpm release:macos:signed:fixture
pnpm test:macos:release
pnpm test:macos:signed-release
pnpm check:macos:release-workflow
```

## Routine test app bundle

Run the same bundle path locally on an Apple Silicon Mac:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build:macos
```

The command is an explicit alias for `alpha-ad-hoc`; it does not inspect Apple
credentials to choose a layout. It downloads only the pinned Mihomo v1.19.29
Darwin ARM64 release with `gh`, checks the published archive SHA-256 before
extraction, signs the Core and application ad hoc, then enables the
packaging-only Tauri resource configuration and builds `Mish.app`. Keeping
generated resources out of the base Tauri configuration lets clean validation
builds remain offline.
The post-build verifier checks the stable application identifier, ARM64
architecture, exact uncompressed Core checksum and version, complete
byte-for-byte offline Web resource mirror, the repository's `LICENSE`,
`THIRD_PARTY_NOTICES.md`, the complete pinned GeoData fallback snapshot, and
code-signing structure. Ad-hoc packages must contain no privileged artifact.

Run `pnpm test:macos:bundle` for fast synthetic negative layouts. Run
`pnpm desktop:bundle:fixture:macos` to produce and inspect the complete
legacy privileged-layout fixture without credentials. That fixture remains only
to prevent accidental weakening of the production TUN gate: it signs the app
and helper ad hoc, proves the structure and closed version probes, and proves
that both artifacts fail the required Developer ID team checks. It is not a
release profile and never registers or launches the LaunchDaemon.

GitHub Actions wraps the app with `ditto` as `Mish-<short-sha>.app.zip` and
uploads an artifact named `mish-macos-arm64-<short-sha>` for 14 days. This is a
test package: an ad-hoc signature is not an Apple identity, is not notarized,
does not make the TUN helper available, and is not a stable public release.

## Public release split

The completed packaging-readiness audit selected a System Proxy-only first
public release. That release does not depend on a production privileged TUN
helper and must omit both the helper executable and LaunchDaemon property list.
The explicit `alpha-ad-hoc` profile implements a credential-free no-helper Alpha
mode. The explicit `signed-direct` Stage 1 profile defines the future Developer
ID no-helper application contract without using credentials. Signing inputs no
longer select or imply a helper-bearing layout.

Before public distribution, complete live Developer ID signing and notarization
with independent `codesign`, stapler, and Gatekeeper distribution checks, a
versioned DMG and GitHub Release with SHA-256 and exact source revision, and
clean-account install, upgrade, relocation, uninstall, recovery, System Proxy
restoration, and rollback-policy acceptance. Release, support, privacy,
security-contact, dependency-notice, and supply-chain policies also remain
open. Dependency attribution and unresolved license-source questions are
recorded in
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

A TUN-enabled distribution remains a separate future path tracked by
[#85](https://github.com/Asuka109/mish/issues/85),
[#95](https://github.com/Asuka109/mish/issues/95), and
[#98](https://github.com/Asuka109/mish/issues/98). The selected first-release
direction keeps Virtual Interface unavailable, but this document does not claim
that the planned explanatory interaction is implemented.

## Download and launch a test package

Open the repository's **Actions** tab, select a successful **CI** run for a push
to `main`, and confirm that the **Package macOS ARM64** job succeeded. Its job
summary records the short commit SHA, artifact name and ID, signing state, and
the SHA-256 of the inner app archive. Download the matching artifact from the
run's **Artifacts** section. GitHub expands the outer artifact archive during a
CLI download; a browser download may require opening that outer ZIP first.

Verify and expand the resulting app archive before launch:

```sh
cd /path/to/download
shasum -a 256 Mish-<short-sha>.app.zip
ditto -x -k Mish-<short-sha>.app.zip .
open Mish.app
```

The digest must exactly match **Archive SHA-256** in the package job summary.
The current credential-free package is deliberately ad-hoc signed and not
notarized, so Gatekeeper may require one app-scoped confirmation. In Finder,
Control-click `Mish.app`, choose **Open**, then confirm **Open**. If macOS instead
shows the block in **System Settings > Privacy & Security**, use **Open Anyway**
for Mish only after checking the digest and run identity. Do not disable
Gatekeeper globally. This exception is appropriate only for this verified Mish
test app; remove the extracted app when testing is complete.

If an automated merge credential does not emit a follow-up push workflow,
manually dispatch the CI workflow on `main` with task `packages`. The bounded
recovery path checks out the latest `main` and rebuilds the macOS and Android
test packages without running the heavy inspection. Manual task `inspection`
remains the default.

## Clean-account install and first launch

Use a fresh standard macOS account to validate the prototype boundary. After
verifying the archive as described above, install the app for that account:

```sh
mkdir -p "$HOME/Applications"
ditto Mish.app "$HOME/Applications/Mish.app"
open "$HOME/Applications/Mish.app"
```

Approve only the app-scoped Gatekeeper prompt described above. On first launch,
Mish starts with no active profile, System Proxy off, TUN unavailable, and
launch at login off. It does not install a privileged helper, system extension,
certificate, updater, crash reporter, or system-wide daemon. Import and activate
a known test profile before enabling System Proxy. Closing the default main
window hides it to the status bar; clicking the Dock icon or choosing **Open
Mish** from the status menu reveals the same window. Use **Mish > Quit Mish**,
Command-Q, or the status menu's **Quit Mish** command to enter the same ordered
proxy restoration.

For a clean-account acceptance pass, confirm that the window restores its last
on-screen size and position after a quit/relaunch, Command-W follows the selected
close behavior, Command-M minimizes, Command-, opens Settings, Command-F focuses
search where the page provides it, and a Dock reopen reveals a hidden window.
Run VoiceOver through the sidebar, toolbar, current page heading, and primary
controls. Leave the app hidden and idle for at least ten minutes and confirm that
its decorative animation is stopped and Activity Monitor does not show sustained
CPU use.

## Remove Mish and account-local application state

Before removal, turn System Proxy off and confirm the UI reports it off. Disable
**Launch at login** in Settings, then quit Mish normally. If Mish reports System
Proxy drift or the app was previously terminated abnormally, reopen it and use
the offered repair action before deleting its data. `scutil --proxy` can be used
as a read-only final check.

Inspect Mish ownership, mounted images, and the exact app and account-local
state targets without changing anything:

```sh
pnpm macos:app:clean -- inspect
```

Every mutating subcommand requires the explicit `--apply` confirmation:

| Subcommand            | Behavior                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `stop --apply`        | Requests application-level Quit and waits up to 15 seconds for Mish's normal reconciliation.                                   |
| `force-stop --apply`  | Sends TERM only to exact Mish/Core PIDs, then KILLs only PIDs that are still confirmed owned after the bounded wait.           |
| `reset-proxy --apply` | Uses Mish's validated recovery journal and Rust platform adapter to restore the exact pre-Mish System Proxy state.             |
| `clean --apply`       | Unregisters the account LaunchAgent and moves the inspected app and account-local state targets to the Trash.                  |
| `all --apply`         | Attempts safe Quit, uses force-stop only as fallback, restores Mish-owned System Proxy state, then performs the Trash cleanup. |

For example, perform the complete reset after reviewing `inspect`:

```sh
pnpm macos:app:clean -- all --apply
```

System Proxy reset never blindly disables a network service. Without a valid
Mish recovery journal, an existing loopback proxy is treated as unowned and left
unchanged. Process control is restricted to the installed
`/Applications/Mish.app` (or account-local installed app) and its directly owned
Core; a Mish instance running from another worktree is reported but never
stopped. The facility never force-detaches a disk image or touches a Mish DMG
mounted by another worktree. Trash cleanup includes the entire private
Application Support root (`settings.json`, profiles, runtime state, journals),
preferences, caches, WebKit/HTTP storage, cookies, saved state, logs, and bounded
Mish CrashReporter/DiagnosticReports entries, including legacy
`mish-desktop`-named state. Listed files remain recoverable until the Trash is
emptied. User-selected exports and backups, mounted DMGs, and development TUN
services are intentionally not deleted. A developer who separately installed
the development TUN service must also run `pnpm macos:tun:uninstall` from the
trusted checkout.

## Developer ID and notarization secrets

The unexecuted `signed-direct` live workflow path requires the protected
`macos-developer-id` Environment and all of these Environment secrets:

| Secret                              | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `MISH_APPLE_CERTIFICATE_BASE64`     | Base64-encoded Developer ID Application `.p12` |
| `MISH_APPLE_CERTIFICATE_PASSWORD`   | Password used when exporting the `.p12`        |
| `MISH_APPLE_SIGNING_IDENTITY`       | Exact keychain identity, including team suffix |
| `MISH_APPLE_NOTARY_API_KEY_ID`      | App Store Connect API key ID                   |
| `MISH_APPLE_NOTARY_API_ISSUER_ID`   | App Store Connect API issuer ID                |
| `MISH_APPLE_NOTARY_API_PRIVATE_KEY` | Complete private `.p8` key contents            |

Do not commit certificates, passwords, or private keys. A partial secret set
fails before creating the temporary keychain instead of silently falling back
to ad-hoc signing. Certificate configuration therefore always implies
notarization configuration for this workflow. The build child receives only
the exact identity, derived team identifier, and protected-boundary marker; it
never receives the certificate, passwords, or notary key. See Tauri's official
[macOS code-signing and notarization guide](https://v2.tauri.app/distribute/sign/macos/)
for the upstream environment-variable contract.

Configuring these secrets is not proof of Developer ID trust, notarization,
Gatekeeper acceptance, or release readiness. Only observed, ordered evidence
from an accepted protected run can make the exact candidate Draft-eligible, and
Stage 1 repository tests do not produce that evidence.

## Future TUN-enabled production gate

The application signing identifier is `com.asuka109.mish`. Developer ID
packaging embeds the production-only `com.asuka109.mish.tun-helper` executable
at `Contents/Resources/mish-tun-helper` and its property list at
`Contents/Library/LaunchDaemons/com.asuka109.mish.tun-helper.plist`. The plist
uses `BundleProgram` with the first path and exposes only the exact helper Mach
service. Ad-hoc packaging omits both artifacts and continues to report TUN as
unpackaged.

The helper remains unavailable until the application has independently
confirmed all of these conditions:

1. the helper and app are signed by the expected Developer ID team with their
   exact signing identifiers;
2. the app embeds a valid `SMAppService` LaunchDaemon property list and matching
   executable under the documented bundle locations;
3. the registered service reports the exact expected helper version;
4. mutual XPC code-signing requirements accept only those identities; and
5. XPC health and a disabled TUN state are freshly observed.

Ad-hoc signatures never pass those checks. The production gate validates both
code objects against an Apple-issued Developer ID Application requirement with
their exact identifiers and configured team, then reads the exact LaunchDaemon
status through `SMAppService`. `enabled` alone is insufficient: a matching
version, protocol, healthy production XPC response, and fresh observation that
the owned interface/routes/DNS effects are absent are also mandatory.

The current production executable intentionally has no development Unix-socket
or installer behavior. Until a separately reviewed production XPC command
transport supplies that health and observation evidence, even a correctly
signed and registered package remains recovery-required. Actual signing,
notarization, registration, administrator approval, and live production TUN
acceptance remain outside the credential-free gate.

Local source development is separate from this packaging gate. On Apple
Silicon, `pnpm macos:tun:install` installs an explicitly authorized root
LaunchDaemon and pinned Core outside the app bundle. The development app
verifies its per-user Unix socket and uses it as the sole Mihomo process owner;
packaged builds never discover or trust that development service.

The development installer uses fixed helper, Core, property-list, socket, and
private receipt paths. Reinstall overwrites those targets and derives a fresh
artifact identity without retaining per-install temporary directories or old
binaries. Uninstall stops the service and moves only those bounded Mish-owned
targets to Trash. Managed Core activation likewise retains at most the active
candidate plus one in-flight replacement and prunes only validated UUID-named
stale candidates after startup recovery.

Both `pnpm macos:tun:install` and the development app's onboarding/Settings
actions present the macOS administrator authorization dialog and run the same
fixed install plan. `pnpm macos:tun:repair` is the CLI equivalent of Settings'
clean reinstall action. Mish does not collect administrator credentials, and a
cancelled prompt leaves the helper lifecycle unconfirmed.
