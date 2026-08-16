# Clash Verge Rev Deep Walkthrough

- Date: 2026-07-18
- Application: Clash Verge Rev for macOS
  Bundle identifier: `io.github.clash-verge-rev.clash-verge-rev`

## Purpose

This report records a systematic, read-only-oriented Computer Use walkthrough
of the installed Clash Verge Rev application. It complements a local private
competitor reference set by covering primary pages, secondary surfaces, and
content that is only visible after scrolling. The private source material is
intentionally excluded from version control.

This document is research evidence, not a revision of the product PRDs.

## Environment and Method

### Observed environment

- Verge version: **2.5.1 (2.5.1)**, confirmed in the native About dialog and
  the Settings page.
- Core: **Mihomo v1.19.25**, confirmed on Home and in Settings.
- The Home system card reported **Darwin macOS 26.5.2**.
- Runtime mode at the end of the walkthrough: **Rule**.
- Mixed port: **7897**; displayed system proxy address: `127.0.0.1:7897`.
- System Proxy: off.
- TUN: off and unavailable until the service is installed.
- No imported or active subscription/profile was present.
- No active proxy node, rules, active connections, closed connections, or log
  rows were available.

### Method

- The application was operated through Computer Use and inspected through its
  accessibility tree and screenshots.
- Every primary navigation item was opened.
- Each scrollable primary surface was inspected at its top and bottom; Home,
  Settings, Network Interfaces, DNS override, and the runtime configuration
  editor received explicit top-to-bottom passes.
- Safe dialogs, tabs, lists, nested editors, and dropdown menus were opened and
  closed without saving.
- Actions that would install a service, enable a proxy or TUN, import or update
  a subscription, run connectivity/unlock tests, close connections, clear
  logs, update software/resources, create or restore backups, or alter files
  were not executed.

### Interaction caveat

Two controls initially looked like view tabs/cyclic menus but were direct state
controls:

- The Proxies `Global` control was opened briefly, then immediately restored to
  `Rule`. The read-only runtime configuration viewer subsequently confirmed
  `mode: rule`.
- The Home node-sort control was cycled through latency and name sorting while
  identifying its states, then returned to `Default sorting`.

The External Controller enable switch was also toggled only inside an unsaved
modal to reveal disabled fields, then the modal was cancelled. The runtime
configuration remained `external-controller: ''`. These temporary changes did
not enable System Proxy, TUN, or an external listener.

## Coverage Matrix

`Top / middle / bottom` describes visual scroll coverage, not merely the fact
that an off-screen element appeared in the accessibility tree.

| Primary page     | Secondary control or surface        | Viewed state and scroll evidence                                                                                                                                                                                                                                                                                                                                                                  | Inaccessible or deliberately skipped                                                                                                     | Product observations                                                                                                                               |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home             | Page overview                       | Top: subscription, current node, network, and mode cards. Middle: traffic chart, site tests, and IP card. Bottom: Clash and system information cards.                                                                                                                                                                                                                                             | None for scrolling.                                                                                                                      | A customizable dashboard assembles setup, control, monitoring, and diagnostics in one long surface.                                                |
| Home             | Home settings                       | Modal listed nine independently visible cards: Subscription, Current Proxy, Network, Proxy Mode, Traffic, Website Tests, IP Information, Clash Information, and System Information. Cancelled without changes.                                                                                                                                                                                    | Save was not used.                                                                                                                       | Dashboard personalization is explicit and card-granular.                                                                                           |
| Home             | Subscription and current node       | Empty state showed `Import subscription`, `No proxy nodes`, delay-test affordance, and three node sort states: Default, latency, and name. Sort was restored to Default.                                                                                                                                                                                                                          | Import, paste, delay test, and node selection were not run; no profile existed.                                                          | Empty states retain the eventual control vocabulary instead of replacing the workspace with onboarding only.                                       |
| Home             | Network and proxy mode              | System Proxy and TUN statuses were visible; TUN showed the missing-service explanation. Rule, Global, and Direct mode descriptions were visible.                                                                                                                                                                                                                                                  | System Proxy, TUN, service install, and mode changes were not executed from Home.                                                        | Operational controls are duplicated on Home for fast access, with prerequisite messaging inline.                                                   |
| Home             | Traffic                             | Ten-minute upload/download chart plus upload speed, download speed, active connections, totals, and core memory.                                                                                                                                                                                                                                                                                  | No live traffic was generated.                                                                                                           | The card combines time series and present-tense counters.                                                                                          |
| Home             | Website tests                       | Four default targets: Apple, GitHub, Google, and YouTube. `Test all` and per-row tests were visible. `New test` opened a form for name, icon, and test URL.                                                                                                                                                                                                                                       | No test request was run; no custom test was saved.                                                                                       | Tests are user-extensible rather than a fixed health check.                                                                                        |
| Home             | IP information                      | Country, ASN, provider, organization, city, timezone, coordinates, masked IP, refresh, and a 300-second auto-refresh countdown were visible.                                                                                                                                                                                                                                                      | IP reveal and manual refresh were not used.                                                                                              | The card balances privacy (masked IP) with fairly deep network identity detail.                                                                    |
| Home             | Clash and system information        | Bottom card showed core version, proxy address, mixed port, uptime, and rule count. System card showed OS, login-start state, user mode, last update check, and app version.                                                                                                                                                                                                                      | The Settings shortcut was observed but not activated from this card.                                                                     | Bottom-of-page operational metadata is richer than the initial viewport suggests.                                                                  |
| Proxies          | Rule view                           | Rule was the original and final state. An empty `GLOBAL` selector group with `DIRECT` was visible. The group contained no imported nodes.                                                                                                                                                                                                                                                         | Provider sections, group tools, group sorting, latency actions, and provider refresh could not appear without a profile.                 | Proxy groups are the central object; in the empty state the selector/group relationship is still visible.                                          |
| Proxies          | Global and Direct controls          | Global was briefly observed and Rule restored. Direct was not activated.                                                                                                                                                                                                                                                                                                                          | Direct activation was skipped because these are runtime routing controls, not harmless tabs.                                             | The three mode controls visually resemble navigation but mutate runtime routing state; a product should distinguish modes from views more clearly. |
| Proxies          | Chained proxy                       | Dedicated chained-proxy surface opened safely. It warned about performance, listed DIRECT and REJECT, required at least two nodes, and disabled `Connect`.                                                                                                                                                                                                                                        | No nodes were added and no chain was connected.                                                                                          | Chain construction is an explicit ordered workflow with strong warning and validation.                                                             |
| Profiles         | Main page                           | Top-to-bottom fit in one viewport: batch operations, update all, runtime profile, reactivate, URL import row, new profile, global merge card, global script card, and script console.                                                                                                                                                                                                             | No profile item existed, so item menus, update metadata, activation, and per-profile editing were unavailable.                           | Global transformation layers are promoted beside subscriptions instead of hidden in advanced settings.                                             |
| Profiles         | Batch mode                          | `Select all`, disabled `Delete selected`, `Done`, and selected-count state were observed.                                                                                                                                                                                                                                                                                                         | No selection or deletion was possible.                                                                                                   | Batch mode changes the page toolbar in place and keeps a visible selection count.                                                                  |
| Profiles         | Runtime profile viewer              | Read-only editor opened, supported maximize/minimize, and was empty because no profile was active.                                                                                                                                                                                                                                                                                                | No runtime subscription content existed.                                                                                                 | A code-editor presentation is used even for read-only generated configuration.                                                                     |
| Profiles         | New profile                         | Modal exposed Remote and Local types. Remote form included name, description, URL, User Agent, HTTP timeout, update interval, use-system-proxy, use-core-proxy, allow-invalid-certificate, and auto-update.                                                                                                                                                                                       | No values were entered or saved.                                                                                                         | Subscription creation exposes transport and trust controls at creation time.                                                                       |
| Profiles         | Global merge / script               | Both cards and type badges were visible. The script console opened and showed an empty state.                                                                                                                                                                                                                                                                                                     | The empty merge/script cards did not expose an editor action in this installed state; no global extension was created.                   | Advanced transformation concepts are first-class but their empty-card affordance is weak.                                                          |
| Connections      | Active / Closed tabs                | Both tabs opened and showed zero rows. Aggregate upload/download totals remained visible. Page fit in one viewport.                                                                                                                                                                                                                                                                               | Row details, close-one, and actual column data could not be observed; `Close all` was not used.                                          | Current and historical connections share one workspace and common filtering.                                                                       |
| Connections      | Filter/sort tools                   | A toolbar button revealed a selector with Default, Upload Speed, and Download Speed; free-text filter remained alongside it.                                                                                                                                                                                                                                                                      | With no rows, column manager/detail behavior could not be distinguished further.                                                         | Sorting and free-text filtering are compactly combined, but an unlabeled icon weakens discoverability.                                             |
| Rules            | Main page                           | Page fit in one viewport and showed a free-text filter plus empty state.                                                                                                                                                                                                                                                                                                                          | Rule rows, match details, provider subviews, provider actions, and bottom-of-list behavior were unavailable because rule count was zero. | Rules are treated as a searchable dataset rather than a settings form.                                                                             |
| Logs             | Main page                           | Page fit in one viewport. Toolbar exposed Pause, reverse chronological order, Clear, severity selector, and free-text filter. Severity choices: All, Debug, Info, Warn, Error.                                                                                                                                                                                                                    | Pause/order were not changed; Clear was not used. No rows existed, so long-list bottom behavior and row detail were unavailable.         | Operational log controls are always visible even when the dataset is empty.                                                                        |
| Unlock Tests     | Service grid                        | All cards were simultaneously visible; a downward scroll produced no additional rows. Services: Bilibili Mainland, Bilibili Hong Kong/Macau/Taiwan, Bahamut Anime, ChatGPT iOS, ChatGPT Web, Claude, Disney+, Gemini, Netflix, Prime Video, Spotify, TikTok, and YouTube Premium.                                                                                                                 | `Test all` and every per-service test were skipped because they issue network requests.                                                  | The page uses a dense, scan-friendly service grid with consistent pending/result areas.                                                            |
| Settings         | Primary page                        | Top: system settings and documentation links. Middle: Clash and base settings. Bottom: complete advanced-settings list, diagnostic export, and version.                                                                                                                                                                                                                                           | Mutating switches and direct actions were not used.                                                                                      | Four large groups coexist in a two-column layout; the bottom contains important capabilities that are not visible initially.                       |
| Settings         | TUN configuration                   | Modal showed System/GVisor/Mixed stacks, device name, auto-route, strict route, auto-detect interface, DNS hijack, MTU, and excluded CIDR list.                                                                                                                                                                                                                                                   | No values changed, defaults reset, service installed, or configuration saved.                                                            | TUN is a structured subsystem rather than a single switch; prerequisite and advanced routing controls belong together.                             |
| Settings         | System Proxy configuration          | Modal showed current status/address, proxy host, PAC mode, proxy guard, guard interval, default bypass, bypass validation, and the effective bypass list.                                                                                                                                                                                                                                         | No save, PAC, guard, or proxy activation.                                                                                                | The product exposes both desired settings and effective OS proxy state in the same dialog.                                                         |
| Settings         | Network Interfaces                  | Modal was scrolled from first to last interface. It listed IPv6 toggle, interface names, IPs where present, MAC addresses, and copy affordances; `en0` showed the active LAN address and `lo0` loopback.                                                                                                                                                                                          | IPv6 view was not toggled and no values were copied.                                                                                     | A read-only inventory is embedded at the point where interface selection matters.                                                                  |
| Settings         | DNS override                        | Large modal was inspected at top, middle, and bottom. Basic fields covered enablement, listen address, fake-ip/redir-host mode, fake-IP range, blacklist/whitelist filter mode, IPv6, HTTP/3, routing-rule following, hosts use, system hosts, nameservers, fallback, proxy-node DNS, direct DNS, fake-IP filters, nameserver policy, GeoIP fallback, fallback CIDRs/domains, and Hosts mappings. | No reset, toggle, field edit, or save.                                                                                                   | This is effectively a full DNS product inside one modal; progressive disclosure and validation will be critical in a new client.                   |
| Settings         | External controller                 | Modal showed enablement, listen address `127.0.0.1:9097`, secret, and copy actions. Disabled fields were revealed transiently inside the unsaved modal.                                                                                                                                                                                                                                           | No listener was saved or started.                                                                                                        | Security-relevant endpoint and secret controls are colocated, but CORS is only visible in generated runtime configuration.                         |
| Settings         | Web UI                              | Modal listed MetaCubeXD, YACD, and Zashboard URLs with `%host`, `%port`, and `%secret` placeholders plus Open, Edit, Delete, and New. New-entry form accepted a templated URL.                                                                                                                                                                                                                    | No external URL opened and no entry was edited, deleted, or saved.                                                                       | Multiple dashboards are modeled as user-editable URL templates, not a single bundled UI.                                                           |
| Settings         | Core                                | Modal listed Mihomo stable and Mihomo Alpha preview builds, with Upgrade Core and Restart Core.                                                                                                                                                                                                                                                                                                   | Selection, upgrade, and restart were not executed.                                                                                       | Channel choice and lifecycle actions share one compact surface.                                                                                    |
| Settings         | Traffic tunnels                     | Modal exposed TCP, UDP, and TCP+UDP; local host/port; target host/port; optional proxy group/node; Add; and modal Save. It displayed defaults but no saved tunnel list.                                                                                                                                                                                                                           | No tunnel was added or saved.                                                                                                            | A tunnel is modeled as a reusable local forwarding rule with optional routing pinning.                                                             |
| Settings         | Language, appearance, tray, startup | Language list contained 13 languages. Theme mode offered Light, Dark, and System. Tray click choices: show main window, show tray menu, System Proxy, TUN, disabled. Environment export: Bash, Fish, Nushell, CMD, PowerShell. Startup page offered all eight primary pages.                                                                                                                      | No option was selected.                                                                                                                  | Desktop behavior is highly configurable, including actions that turn the tray icon into a direct operational toggle.                               |
| Settings         | Theme settings                      | Modal exposed semantic colors, font family, and CSS injection. Nested CSS editor supported Paste, Format Document, and maximize/minimize.                                                                                                                                                                                                                                                         | No CSS or color value was changed or saved.                                                                                              | Theme customization crosses from approachable tokens into expert-level code injection.                                                             |
| Settings         | Interface settings                  | Modal exposed system title bar, chart visibility, core usage, group icons, pause rendering on blur, notification corner, hover navigation and delay, nav icon style, collapsed nav, tray icon style, tray speed, tray group placement, outbound mode placement, and three custom tray icons.                                                                                                      | No instant-persisting switch or choice was changed.                                                                                      | Navigation, rendering, and tray design are managed together; some controls are platform-specific and should be capability-gated.                   |
| Settings         | Miscellaneous                       | Modal exposed app log level/size/count, auto-close connections, auto-update check, compatibility enhancement, proxy-page columns (Auto or 1–5), log retention (never, 1, 7, 30, 90 days), automatic latency checks, default test URL, and timeout.                                                                                                                                                | No value was changed or saved.                                                                                                           | Operational housekeeping and performance behavior are mixed; a future information architecture should separate them.                               |
| Settings         | Hotkeys                             | Modal listed global enablement plus bindings for panel, Rule/Global/Direct, System Proxy, TUN, lightweight mode, and reactivating subscription.                                                                                                                                                                                                                                                   | No hotkey was recorded, removed, or saved.                                                                                               | Hotkeys cover the same operational actions as Home/tray, reinforcing a multi-surface command model.                                                |
| Settings         | Backup                              | Modal showed timed local backup, backup frequency, automatic backup after merge/script changes, manual local/WebDAV backup, histories, import, and WebDAV configuration. History dialog had Local and WebDAV tabs. WebDAV settings contained server URL, username, password, reveal, and Save.                                                                                                    | No backup/import/restore/delete/upload, credentials, or save.                                                                            | Backup is treated as a lifecycle feature, with separate local/remote histories and triggers tied to risky configuration edits.                     |
| Settings         | Current configuration               | Read-only maximized YAML editor was scrolled to line 30 at the bottom. It exposed effective runtime values such as Rule mode, port, LAN, log level, IPv6, controller, CORS origins, empty tunnels, and TUN settings.                                                                                                                                                                              | The editor was not edited; the accessibility API labels it settable even though the UI labels it read-only.                              | An effective-config view is essential for diagnosing layers and overrides; syntax editor plus minimap serves expert users.                         |
| Settings         | Lightweight mode                    | Modal showed immediate-entry language and automatic entry after the window has been closed for a period.                                                                                                                                                                                                                                                                                          | Lightweight mode was not entered or enabled.                                                                                             | Headless/core-only operation is treated as a deliberate desktop mode, not merely `close to tray`.                                                  |
| Settings         | Advanced action list                | Configuration/core/log directories, update check, developer tools, exit, diagnostic export, and version-copy controls were all visible at the page bottom.                                                                                                                                                                                                                                        | Directory opening, update, developer tools, exit, export, and clipboard copy were not used.                                              | Important support and recovery actions live below the fold and need a clearer diagnostics grouping.                                                |
| macOS menus      | App, File, Edit, View, Window, Help | App menu: About, Services, Hide, Quit. About confirmed 2.5.1 and GPLv3. File: Close Window/All. Edit: standard edit/autofill/dictation/symbols. View: Full Screen. Window: standard window-management commands. Help was empty.                                                                                                                                                                   | Quit and window-changing commands were not used.                                                                                         | Native menu integration is mostly boilerplate; product-specific commands are concentrated in the in-app UI and tray.                               |
| macOS status bar | Tray menu                           | Attempted through both `SystemUIServer` name and `com.apple.systemuiserver`; the Computer Use runtime timed out and exposed only the app window/menu bar.                                                                                                                                                                                                                                         | Tray menu contents could not be observed in this run.                                                                                    | Tray behavior must remain a named follow-up acceptance surface, especially because Settings exposes extensive tray configuration.                  |

## Secondary Surface Inventory

This section condenses the settings dialogs into implementation-sized groups.

### System and routing

- TUN configuration: stack, device, route strategy, DNS hijack, MTU, excluded
  networks.
- System Proxy configuration: desired host plus effective state, PAC, guard,
  bypass defaults and validation.
- External controller: listener, secret, copy actions.
- Traffic tunnels: protocol, local endpoint, target endpoint, optional
  group/node routing.

### Core and data plane

- Network-interface inventory with copyable IP/MAC data.
- DNS override with basic and expert fields.
- Core channel and lifecycle controls.
- Effective runtime YAML with read-only maximized editor.

### Desktop shell

- Language, theme mode, tray-click action, environment export shell, startup
  page, and startup script.
- Theme tokens, font family, and CSS injection editor.
- Interface rendering, navigation, notification position, and tray placement.
- Global hotkeys for window and network modes.
- Lightweight/headless mode.

### Support and lifecycle

- Local and WebDAV backup, triggers, histories, import, and credentials.
- Log retention and size controls.
- Configuration/core/log directories.
- Update, diagnostic export, and developer tools.

## Observed Facts vs. Design Inference

The following are **observed facts**:

- Clash Verge Rev uses eight primary pages: Home, Proxies, Profiles,
  Connections, Rules, Logs, Unlock Tests, and Settings.
- Home is a long, card-based customizable dashboard.
- Settings is a long two-column page whose rows open substantial dialogs.
- Several dialogs are themselves deep workspaces, especially DNS, TUN,
  Interface, Backup, and Current Configuration.
- The same operational commands recur across Home, Settings, hotkeys, and tray
  configuration.
- Empty datasets remove many secondary tools from the accessibility tree.

The following are **design inferences for this project**, not claims made by
Clash Verge Rev:

- Primary information architecture should be based on user jobs, while
  platform-specific shell controls should remain capability-gated.
- System Proxy, TUN, outbound mode, selected group/node, and active profile are
  one interdependent operational state. Repeating them across surfaces is
  useful only if every surface uses the same state model and terminology.
- DNS and TUN are too large for a single undifferentiated modal in a new
  implementation. A basic summary plus an expert editor/subpage would preserve
  both approachability and power.
- Effective runtime configuration and generated routing explanations are more
  valuable for diagnosis than exposing only editable source settings.
- Empty states should preserve table/group structure with representative
  column and action explanations; otherwise important interaction design is
  invisible until users risk importing a live profile.
- Controls that change routing mode should not look like tabs. Mode changes
  require explicit state styling and, where consequences are broad, contextual
  explanation.
- Support, backup, update, directories, and diagnostic export deserve a coherent
  `Diagnostics & Recovery` area rather than a below-the-fold action list.

## Blockers and Unverified Areas

### Caused by no active subscription/profile

- Proxy provider cards and provider refresh/update controls.
- Populated policy groups, group expansion, alphabetical jump navigation,
  group sorting, latency testing, and actual node selection.
- Per-profile menus, metadata, update failures, activation, ordering, and
  deletion confirmations.
- Runtime subscription content and global merge/script behavior against a real
  configuration.
- Connection rows, row detail, route chain, process metadata, close-one, and
  closed-connection history.
- Rule rows, rule-provider subviews, provider details, and long-list behavior.
- Populated logs, pause/order behavior on a live stream, virtualized scrolling,
  and bottom retention.

### Deliberately not executed

- Network-impacting controls: System Proxy, TUN, routing modes beyond the
  immediately restored Global observation, chain connect, tests, core restart,
  and tunnel creation.
- Persistent configuration: imports, saves, deletes, switches, hotkeys, CSS,
  backup/restore, updates, service installation, and resource updates.
- Destructive or disruptive actions: close connections, clear logs, exit,
  directory cleanup, and developer tools.

### Tool limitation

- The macOS status-bar/tray menu could not be reached through the Computer Use
  app target. It must be inspected in a follow-up run with a tool that can
  target status items or with the user manually opening the menu.

## Profile-backed Follow-up

A second Computer Use pass used a private, temporary derivative of the current
Mihomo router configuration. No configuration file, endpoint, credential,
private node label, public IP, subscription URL, or screenshot was added to the
repository.

### Safety and compatibility preparation

- The source configuration passed Mihomo 1.19.27 validation on its original
  host.
- The temporary import contained 10 inline proxies, 13 policy groups, 44
  ordered rules, and one HTTP rule provider. It had no proxy providers.
- A router-specific absolute Web UI path was removed from the temporary copy
  because the desktop core correctly rejected it outside the allowed home
  directory.
- The temporary copy changed its source `tun.enable` value to `false` and
  removed source-owned controller fields before desktop import. System Proxy
  and TUN remained off throughout the follow-up.
- The resulting temporary profile passed the bundled desktop Mihomo 1.19.25
  configuration test before import.
- Import selected the profile but did not immediately replace the empty
  runtime. Explicit reactivation produced a success state and populated the
  runtime. This makes activation acknowledgement and last-known-good rollback
  important product requirements.

### Newly observed surfaces

| Surface             | Profile-backed observation                                                                                                                                                                                                                                                                                      | Product consequence                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Home                | The active profile replaced the import empty state. Current group and child selectors, traffic totals, memory, and a nonzero rule count populated in the same card layout.                                                                                                                                      | Status needs one coherent active-profile context, but should remain a compact workbench rather than a long customizable dashboard.                           |
| Profiles            | Right-click menu exposed Use, Edit Info, Edit File, Edit Rules, Edit Proxies, Edit Proxy Groups, Extension Override, Extension Script, Open File, and Delete.                                                                                                                                                   | These are capability inputs. Our product should use visible object actions and patch ownership instead of a hidden context menu as the primary editing path. |
| Profile metadata    | Local metadata editor contained type, name, description, and update interval. Batch mode supported Select All, Delete Selected, Done, and a selected count.                                                                                                                                                     | Lifecycle metadata and bounded batch scope belong to Profiles.                                                                                               |
| Rule editor         | Visual editor supported rule type, payload, target policy, insertion before or after the source list, search, row deletion, and a switch to a raw editor.                                                                                                                                                       | Common rule changes can be structured patches; advanced compatibility still needs raw preservation and validation.                                           |
| Proxy editor        | Visual editor accepted newline-separated proxy URIs, including Base64 input, supported insertion before or after the source list, filtering, deletion, and a raw editor.                                                                                                                                        | Manual protocol authoring is not required for P0, but source patches need an extensible representation.                                                      |
| Group editor        | Visual form included group type/name/icon, proxy and provider inclusion, health-check URL/status/interval/timeout/failure limit, outbound interface, routing mark, include/exclude filters, include-all variants, lazy mode, UDP disable, hidden state, insertion order, filtering, deletion, and a raw editor. | Group configuration is a substantial expert object and should not be compressed into a generic settings modal.                                               |
| Override and script | Per-profile override and script actions opened code editors with Paste, Format Document, maximize/minimize, Cancel, and Save.                                                                                                                                                                                   | Transform layers require explicit provenance, preview, rollback, and a later security review.                                                                |
| Runtime profile     | Read-only viewer showed a generated configuration in which application-owned runtime values differed from the source.                                                                                                                                                                                           | The product needs a layered effective-config inspector that explains each override instead of presenting only final YAML.                                    |
| Routes              | Twelve non-hidden groups appeared in group navigation. Expanding a group exposed current child, scoped latency test, configuration/latency/name sorting, a test-URL field, node-detail toggle, text filter, and child cards with protocol and UDP capability metadata.                                          | Keep tools group-scoped and preserve hidden-group semantics; do not invent one global node.                                                                  |
| Chained proxy       | Populated chain mode added a policy-group selector, ordered node selection instructions, a minimum of two nodes, disabled Connect until valid, and repeated performance warnings.                                                                                                                               | Chain construction is a dedicated expert workflow, not a normal route switch.                                                                                |
| Connections         | A synthetic scoped request produced one active row with destination, network/protocol, route chain, age, and bytes. Detail added host, totals and rates, matched rule, process when available, source, target, port, and connection type. Close One moved it to bounded Closed history, which exposed Clear.    | Traffic should combine row summary, expandable evidence, explicit command scope, and bounded history.                                                        |
| Connection sorting  | Selector choices were Default, Upload Speed, and Download Speed; free-text filtering remained visible.                                                                                                                                                                                                          | Sort state and filter state are independent, named controls.                                                                                                 |
| Rules               | The 44-row ordered list was scrolled from top to bottom. Observed types included IP CIDR, GeoIP, GeoSite, destination port, domain, domain suffix, logical AND, and final Match.                                                                                                                                | Effective priority and type/payload/target search belong in Traffic's Rules subview.                                                                         |
| Rule provider       | Provider dialog showed name, record count, last-update age, HTTP source type, IP-CIDR behavior, Update, and Update All. No update was executed.                                                                                                                                                                 | Provider source lifecycle belongs to Profiles, with effective contents linked from Traffic.                                                                  |
| Logs                | Live rows showed timestamp, severity, protocol, route decision, and warning detail. Controls included pause, reverse order, clear, All/Debug/Info/Warn/Error, and text filtering.                                                                                                                               | Events should merge these facts with app and platform events and keep clearing local-view scope explicit.                                                    |
| Unlock test         | One service-specific probe was executed. Its pending state became a support result with region code and timestamp.                                                                                                                                                                                              | Service probes should be neutrally named diagnostics with route, time, and scope, not a primary entertainment-unlock destination.                            |

### Closed and remaining gaps

The follow-up closed the original gaps for populated selector groups,
profile-item menus, rule/provider views, active and closed connection details,
live logs, and one service-test result. The following remain unverified:

- proxy-provider cards, because the private configuration intentionally uses
  inline proxies only;
- populated URL-test, fallback, load-balance, and relay groups;
- remote-profile update failures and rollback behavior;
- long-lived log virtualization under sustained volume;
- the macOS status-bar menu, which remains inaccessible to the Computer Use
  application target.

Any further fixture should be synthetic and contain only non-sensitive labels,
endpoints, nodes, connections, and logs.
