# Contributing to Mish

Mish is an experimental, cross-platform client with network and operating-system
effects. Contributions should be narrow, evidence-backed, and explicit about
the platform boundary they change.

## Before you start

1. Search existing issues and pull requests for overlapping work.
2. Read [`PRODUCT.md`](PRODUCT.md) and the task-oriented
   [documentation index](docs/README.md).
3. For interface work, follow [`DESIGN.md`](DESIGN.md).
4. For runtime, packaging, or native work, read the owning architecture and
   quality documents before editing.
5. Do not use real profiles, subscription addresses, credentials, private node
   names, or host network state as fixtures or evidence.

For a behavior change or material bug fix, open an issue before substantial
work unless a maintainer has already approved the scope. Security
vulnerabilities use the private process in [SECURITY.md](SECURITY.md), not a
public issue.

## Development

The supported baseline is Node.js 24, pnpm 11.13.1, and stable Rust.

```sh
pnpm install --frozen-lockfile
pnpm check:pr
```

Use [`bootstrap.md`](bootstrap.md) for workstation setup and
[`docs/operations/development-commands.md`](docs/operations/development-commands.md)
for focused commands. Tests must not silently enable System Proxy, TUN, VPN
services, listeners, administrator authorization, or other host mutations.

## Pull requests

Keep each pull request focused on one observable outcome. Include:

- the problem and intended behavior;
- affected platforms and explicit non-goals;
- executed checks and their results;
- fixture, screenshot, or device evidence when the change requires it;
- privacy, security, packaging, localization, and accessibility effects; and
- remaining limitations or follow-up work.

Repository documentation, code comments, commit messages, and pull-request
descriptions should be in clear English. Product copy must update both English
and Simplified Chinese dictionaries and regenerate the typed localization
output.

Do not claim production readiness, official status, platform support, legal
compliance, or compatibility beyond the repository's current validation
evidence. Do not add telemetry, hosted dependencies, proprietary components,
third-party artwork, provider branding, or privileged behavior without an
explicit review of the applicable technical and license boundaries.

## Licensing and provenance

Mish-authored source is distributed under GPL-3.0-only. Third-party material
retains its own license. Do not submit content that you do not have the right to
contribute under terms compatible with the repository and its distribution.
Preserve upstream notices and record the exact source, version, license, and
modification status for copied or derived material.

The project currently has no Contributor License Agreement or Developer
Certificate of Origin workflow. A maintainer may request provenance or
licensing clarification before accepting a contribution.
