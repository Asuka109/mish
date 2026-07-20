# Local-only proxy debugging

## Decision

Mish exposes its application-owned mixed proxy listener as the smallest safe
local debugging path. A desktop user can configure an individual browser
extension or application's HTTP or SOCKS5 proxy as `127.0.0.1:7890`, then run a
bounded listener test from Settings. This path routes only traffic sent by that
client. It does not select, enable, observe, or reconcile macOS System Proxy.

The endpoint is fixed by application policy. Imported profiles cannot replace
it, enable LAN access, add custom listeners, or add listener authentication.
The listener exists only while a validated Profile and the managed Mihomo core
are active. The test accepts no host, port, URL, protocol, timeout, path, or
credential. It performs one bounded TCP readiness check through the existing
capture platform seam and returns only the fixed endpoint plus a closed phase:
`ready`, `core-unhealthy`, `listener-unavailable`, or `runtime-transition`.

Automated tests use injected repository fixtures. They assert that the listener
test does not call the System Proxy apply boundary, does not create a recovery
journal, and leaves the prior platform state unchanged. They never inspect or
mutate the host macOS System Proxy.

## Current product surface

Settings shows **Local-only manual proxy** only for the authenticated desktop
adapter. It presents the fixed endpoint, labels both supported ingress protocols,
explains the per-application traffic scope, and explicitly states that macOS
System Proxy is unchanged. The ordinary browser fixture reports the operation
unavailable and does not pretend to own a local Mihomo listener.

Protocol version 14 adds authenticated `status.testLocalProxy` with empty
parameters and the closed result described above. It does not add an arbitrary
network probe or a new capture-selection mode.

## Embedded arbitrary-web debugging boundary

This slice does not embed arbitrary remote pages in the trusted main WebView.
The main WebView receives the process-only bridge token, is the only window in
the current Tauri capability, and uses a CSP that blocks frames and remote
frontend connections. Relaxing that CSP or navigating the main WebView would
mix untrusted page content with Mish's authenticated local authority.

Tauri can assign a proxy to an individual WebView, but on macOS this requires
the `macos-proxy` Cargo feature and macOS 14 or later. Mish currently supports
macOS 13. See Tauri's
[`WebviewBuilder::proxy_url`](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html#method.proxy_url),
[Webview API](https://v2.tauri.app/reference/javascript/api/namespacewebview/),
and [capability model](https://v2.tauri.app/security/capabilities/).

## Follow-up: isolated in-app debug capture

A future developer-mode implementation may add a sidebar **Debug** destination
with trusted local navigation controls and an isolated remote-content WebView.
It must meet all of these acceptance criteria before shipping:

1. Developer mode is explicit, defaults off, is visibly labelled, and does not
   change the remembered System Proxy or TUN selection.
2. The remote-content WebView has its own label, non-persistent data store, and
   no Tauri capability, bridge token, RPC bootstrap, local application origin,
   filesystem, shell, dialog, event, clipboard-write, or window-management
   permission.
3. The trusted main document keeps the current CSP unchanged. Remote content is
   never framed inside the main document and cannot navigate it.
4. The debug WebView accepts only user-entered `http` or `https` URLs. It rejects
   credentials in URLs and every local, file, data, JavaScript, custom-protocol,
   application, and loopback destination. New-window requests and downloads are
   denied until separately designed.
5. Its proxy is fixed to `http://127.0.0.1:7890`; remote content cannot choose or
   bypass the proxy. The surface is unavailable on macOS 13 and whenever the
   managed listener test is not `ready`.
6. Disabling developer mode, stopping the active Profile, replacing the runtime,
   or quitting Mish destroys the debug WebView and its non-persistent store.
7. Repository fixtures prove creation policy, navigation rejection, lifecycle
   cleanup, and exact non-mutation of System Proxy. Automated tests load no
   arbitrary remote page and never inspect or change host proxy settings.
8. Installed-app acceptance on macOS 14 or later proves that only debug-WebView
   connections appear in Mish Traffic while a simultaneously loaded ordinary
   browser remains on its prior route, and confirms exact System Proxy state
   before and after the run.

Until those criteria are implemented together, browser extensions and
application-specific manual proxy settings are the supported local-only debug
path.
