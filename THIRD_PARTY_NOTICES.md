# Third-Party Notices

Mish is independent software. It is not affiliated with, endorsed by, sponsored
by, or an official client of MetaCubeX, Highsoft, Remix Design, Unsplash, or any
other project or service named below.

Mish-authored source is distributed under GPL-3.0-only. Third-party software,
artwork, icons, names, and trademarks retain their own licenses and ownership.
This document identifies material direct dependencies and packaged assets; it
is not a substitute for a complete, artifact-specific license inventory.
`pnpm-lock.yaml`, `Cargo.lock`, and the Mobile Core SBOM record exact dependency
versions.

## Mihomo

The Apple Silicon macOS test bundle includes the upstream Mihomo Core release
executable. Packaging adds the selected macOS code signature but does not modify
its program source:

- Project: [Mihomo](https://github.com/MetaCubeX/mihomo)
- Copyright: MetaCubeX and Mihomo contributors
- Version: `v1.19.29`
- Source commit: [`e26714a181ac0e2fa803453c0a8e9a9ce94e31cb`](https://github.com/MetaCubeX/mihomo/commit/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb)
- Source tag: [`v1.19.29`](https://github.com/MetaCubeX/mihomo/tree/v1.19.29)
- Official release: [`v1.19.29`](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.29), including [`mihomo-darwin-arm64-v1.19.29.gz`](https://github.com/MetaCubeX/mihomo/releases/download/v1.19.29/mihomo-darwin-arm64-v1.19.29.gz)
- License at the exact commit: [GNU GPL version 3](https://github.com/MetaCubeX/mihomo/blob/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb/LICENSE)
- Corresponding source: [exact commit tree](https://github.com/MetaCubeX/mihomo/tree/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb)

The [upstream README at the exact source commit](https://github.com/MetaCubeX/mihomo/blob/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb/README.md)
asks unaffiliated downstream projects not to include the word “mihomo” in their
names. The downstream project name is **Mish**. Technical documentation uses
the upstream name only to identify the Core, Controller API, source, and
artifacts.

The Mish source corresponding to a test package is the repository revision
identified by the package workflow and archive name:
[github.com/Asuka109/mish](https://github.com/Asuka109/mish).

The source-built, untracked Android Mobile Core artifacts use the same Mihomo
version and source commit. Reproducible build inputs, checksums, the
GPL-3.0-only notice, corresponding-source location, and SPDX SBOM are recorded
under [`mobile-core/evidence/android-v1.19.29`](mobile-core/evidence/android-v1.19.29).
The current SBOM contains unresolved `NOASSERTION` dependency-license fields and
must not be described as complete license clearance.

## Material application dependencies

The following projects are material direct dependencies of the current
application. Their complete transitive graphs and exact installed versions are
recorded in the lockfiles.

| Project                                                   | Use                                                                | Declared license or terms |
| --------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| [Tauri](https://github.com/tauri-apps/tauri)              | Desktop/mobile shell, application APIs, plugins, and build tooling | MIT OR Apache-2.0         |
| [React](https://github.com/facebook/react)                | Web interface runtime                                              | MIT                       |
| [React Router](https://github.com/remix-run/react-router) | Interface routing                                                  | MIT                       |
| [Base UI](https://github.com/mui/base-ui)                 | Accessible unstyled interface primitives                           | MIT                       |
| [Phosphor Icons](https://github.com/phosphor-icons/react) | Bundled interface icon components                                  | MIT                       |
| [Lucide](https://github.com/lucide-icons/lucide)          | Bundled interface icon components                                  | ISC                       |
| [Recharts](https://github.com/recharts/recharts)          | Bundled Status traffic sparkline                                   | MIT                       |
| [Sonner](https://github.com/emilkowalski/sonner)          | In-application transient notifications                             | MIT                       |

Rust application dependencies include Tauri, Tokio, Axum, Reqwest, Serde, and
their transitive dependency graphs under their declared licenses. Before public
binary distribution, the exact target artifact needs a generated and reviewed
license/notice collection rather than relying only on this summary. The
development-only `bbolt-rs` registry manifest currently reports no SPDX license
identifier and also requires provenance review.

## Icons, artwork, and names

Mish brand geometry and generated platform icons under
[`packages/brand-assets`](packages/brand-assets) are repository assets.

The bundled onboarding cover is
[“Retro beige computer model centered on a minimalist background”](https://unsplash.com/photos/SgeRfp8xdfo)
by [Petri R](https://unsplash.com/@petrirh1), obtained under the
[Unsplash License](https://unsplash.com/license).

Default service icons are not bundled. The application requests selected SVGs
from the `remixicon@4.9.1` package through `registry.npmmirror.com` at runtime.
The npm package metadata declares Apache-2.0, while the current upstream
`v4.9.1` source tag displays the
[Remix Icon License v1.0](https://github.com/Remix-Design/RemixIcon/blob/v4.9.1/License),
which contains additional restrictions and identifies possible strong-copyleft
incompatibility. The maintainer must reconcile the exact applicable terms before
public distribution. This request is also disclosed in the README's security
and privacy summary.

Service names and brand icons identify user-configurable reachability-test
targets. They do not imply affiliation, endorsement, availability, or
compatibility.
