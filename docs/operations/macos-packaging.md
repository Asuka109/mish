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
pnpm desktop:bundle:alpha-ad-hoc:macos
```

This credential-free profile rejects Apple signing and notarization credentials,
builds an ARM64 `Mish` DMG, and mounts it read-only for verification. The mounted
image contains only `Mish.app` and an `Applications` shortcut for drag-to-install.
It seals the application and Mihomo with an ad-hoc signature, packages no TUN
helper, LaunchDaemon, SMAppService payload, development helper, or other
privileged content, and compiles the packaged TUN capability as unavailable.
The verifier checks the application identifier, version, architecture, pinned
Mihomo digest and version, offline Web resources, legal resources, signature
structure, DMG layout, and clean detach.

An ad-hoc signature is neither an Apple identity nor notarization. Gatekeeper
rejection or **Open Anyway** is the expected Alpha boundary; do not describe the
DMG as trusted or notarized. This profile does not install a helper, request
administrator authorization, or modify host network state.

## Legacy test app bundle

Run the same bundle path locally on an Apple Silicon Mac:

```sh
pnpm install --frozen-lockfile
pnpm desktop:bundle:macos
```

The command downloads only the pinned Mihomo v1.19.29 Darwin ARM64 release with
`gh`, checks the published archive SHA-256 before extraction, signs the Core and
application ad hoc when no identity is supplied, then enables the packaging-only
Tauri resource configuration and builds `Mish.app`. Keeping generated resources
out of the base Tauri configuration lets clean validation builds remain offline.
The post-build verifier checks the stable application identifier, ARM64
architecture, exact uncompressed Core checksum and version, complete
byte-for-byte offline Web resource mirror, the repository's `LICENSE`,
`THIRD_PARTY_NOTICES.md`, and code-signing structure. Ad-hoc
packages must contain no privileged artifact. Developer ID packages additionally
require the exact sealed helper and LaunchDaemon layout, Developer ID
application/helper identifiers and team, helper/protocol versions, and no
misplaced, linked, mutable, duplicate, set-id, or unexpected privileged content.

Run `pnpm test:macos:bundle` for fast synthetic negative layouts. Run
`pnpm desktop:bundle:fixture:macos` to produce and inspect the complete
production layout without credentials. That fixture signs the app and helper
ad-hoc, proves the structure and closed version probes, and additionally proves
that both artifacts fail the required Developer ID team checks. It never
registers or launches the LaunchDaemon.

GitHub Actions wraps the app with `ditto` as `Mish-<short-sha>.app.zip` and
uploads an artifact named `mish-macos-arm64-<short-sha>` for 14 days. This is a
test package: an ad-hoc signature is not an Apple identity, is not notarized,
does not make the TUN helper available, and is not a stable public release.

## Public release split

The completed packaging-readiness audit selected a System Proxy-only first
public release. That release does not depend on a production privileged TUN
helper and must omit both the helper executable and LaunchDaemon property list.
The explicit `alpha-ad-hoc` profile implements a credential-free no-helper Alpha
mode. It is not a Developer ID or notarized public distribution mode; supplying
release signing credentials remains a separate helper-bearing path and must not
be used for the System Proxy-only Alpha.

Before public distribution, implement and verify the no-helper mode, Developer
ID signing and notarization with independent `codesign`, stapler, and Gatekeeper
distribution checks, a versioned DMG and GitHub Release with SHA-256 and exact
source revision, and clean-account install, upgrade, relocation, uninstall,
recovery, System Proxy restoration, and rollback-policy acceptance. Release,
support, privacy, security-contact, dependency-notice, and supply-chain policies
also remain open. Dependency attribution and unresolved license-source questions
are recorded in
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

## Remove the test app and local state

Before removal, turn System Proxy off and confirm the UI reports it off. Disable
**Launch at login** in Settings, then quit Mish normally. If Mish reports System
Proxy drift or the app was previously terminated abnormally, reopen it and use
the offered repair action before deleting its data. `scutil --proxy` can be used
as a read-only final check.

Move the installed app and its account-local state to the Trash:

```sh
trash "$HOME/Applications/Mish.app"
trash "$HOME/Library/Application Support/com.asuka109.mish"
test ! -e "$HOME/Library/LaunchAgents/Mish.plist" || \
  trash "$HOME/Library/LaunchAgents/Mish.plist"
```

If the app was placed in `/Applications`, move `/Applications/Mish.app` to the
Trash in Finder instead. User-selected exports and backups live at their chosen
destinations and are intentionally not deleted. The ad-hoc app package contains
no TUN helper, launch daemon, system extension, updater, or crash-reporting
state. A developer who separately installed the development TUN service must
also run `pnpm macos:tun:uninstall` from the trusted checkout.

## Developer ID and notarization secrets

The current credentialed helper-bearing packaging path is enabled only when all
of these GitHub Actions secrets are configured:

| Secret                              | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `MISH_APPLE_CERTIFICATE_BASE64`     | Base64-encoded Developer ID Application `.p12` |
| `MISH_APPLE_CERTIFICATE_PASSWORD`   | Password used when exporting the `.p12`        |
| `MISH_APPLE_SIGNING_IDENTITY`       | Exact keychain identity, including team suffix |
| `MISH_APPLE_NOTARY_API_KEY_ID`      | App Store Connect API key ID                   |
| `MISH_APPLE_NOTARY_API_ISSUER_ID`   | App Store Connect API issuer ID                |
| `MISH_APPLE_NOTARY_API_PRIVATE_KEY` | Complete private `.p8` key contents            |

Do not commit certificates, passwords, or private keys. The workflow imports
the certificate into an ephemeral keychain, writes the notary key only under
the runner temporary directory, maps the values to Tauri's documented Apple
environment variables, and removes the temporary material even after failure.
A partial secret set fails before building instead of silently falling back to
ad-hoc signing. Certificate configuration therefore always implies notarization
configuration for this workflow. See Tauri's official
[macOS code-signing and notarization guide](https://v2.tauri.app/distribute/sign/macos/)
for the upstream environment-variable contract.

Configuring these secrets is not sufficient to create the selected System
Proxy-only release. That release needs a distinct mode that signs and notarizes
the application while continuing to omit all privileged TUN artifacts.

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
