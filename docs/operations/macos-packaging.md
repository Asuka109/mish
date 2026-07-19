# macOS Packaging and Signing

Mish produces one Apple Silicon test package from pushes to `main`. Pull
requests run the complete validation job but never build or upload an app
archive. The packaging job is independent from validation so that both jobs are
attempted and report their own failures. A failed application build cannot reach
the artifact upload step.

## Test package

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
byte-for-byte offline Web resource mirror, code-signing structure, and absence
of unverified TUN helper content.

GitHub Actions wraps the app with `ditto` as `Mish-<short-sha>.app.zip` and
uploads an artifact named `mish-macos-arm64-<short-sha>` for 14 days. This is a
test package: an ad-hoc signature is not an Apple identity, is not notarized,
and does not make the TUN helper available.

## Developer ID and notarization secrets

The production path is enabled only when all of these GitHub Actions secrets
are configured:

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

## TUN helper production gate

The application signing identifier is `com.asuka109.mish`. The reserved helper
identifier is `com.asuka109.mish.tun-helper`. Neither the current source tree nor
the packaging workflow contains a helper executable or
`Contents/Library/LaunchDaemons` property list, so packaged builds truthfully
report TUN as unpackaged.

A future helper implementation must remain unavailable until the application
has independently confirmed all of these conditions:

1. the helper and app are signed by the expected Developer ID team with their
   exact signing identifiers;
2. the app embeds a valid `SMAppService` LaunchDaemon property list and matching
   executable under the documented bundle locations;
3. the registered service reports the exact expected helper version;
4. mutual XPC code-signing requirements accept only those identities; and
5. XPC health and a disabled TUN state are freshly observed.

Ad-hoc signatures must never pass those checks. Adding Apple secrets signs and
notarizes the application/Core package only; it does not synthesize a helper or
change the runtime's current `unpackaged` boundary.
