# Security Policy

Mish handles profiles, local process control, loopback RPC, operating-system
proxy settings, and experimental privileged or VPN boundaries. Please report
security-sensitive behavior privately.

## Reporting a vulnerability

The repository does not yet have a verified private vulnerability-reporting
channel. Before making the repository public, a maintainer must enable GitHub
private vulnerability reporting or publish another monitored private contact.

Until that channel exists, do not open a public issue containing exploit details
or sensitive data. Open a minimal public issue asking a maintainer to provide a
private reporting path, without disclosing the vulnerability.

Include only the information needed to reproduce and assess the problem:

- affected commit and platform;
- expected and observed security boundary;
- a minimal reproduction using fictional or redacted data;
- impact and required user interaction; and
- any known workaround that does not create additional risk.

Never send real profiles, subscription addresses, credentials, bridge tokens,
private hostnames, unredacted support bundles, signing material, or unrelated
personal data. The project does not request administrator passwords.

## Supported versions

Mish has no stable release or security-support window. The current `main`
branch is the only version evaluated for fixes. Test packages are short-lived
development artifacts and are not production distributions.

No response-time, remediation-time, disclosure-date, warranty, support, or
credit commitment is offered. Any disclosure plan or credit must be agreed for
the specific report.

## Public hardening documentation

The repository documents its loopback authentication, origin validation,
privileged-operation gates, redaction boundaries, package verification, and
recovery behavior under [`docs/architecture`](docs/architecture) and
[`docs/quality`](docs/quality). Those controls reduce specific risks; they are
not a claim that Mish, Mihomo, a user profile, or a packaged artifact is
universally secure.
