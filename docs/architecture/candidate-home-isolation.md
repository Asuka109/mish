# Historical Fixture Isolation Decision

> Archive: this is tracker decision context, not a production runtime
> authority.

The completed Issue #185 decision keeps disposable candidate fixtures private
to their gate. Current product code does not depend on a candidate-home,
release, or update runtime. The same rule now applies to the Electron DMG and
Android admission fixtures: create them in a temporary owned directory, verify
them with bounded replay, and remove them during cleanup.

The isolated `poc/` tree follows the stricter version of this rule. The
admission checker may read its metadata and scripts, but production manifests,
imports, and runtime composition cannot reach it.
