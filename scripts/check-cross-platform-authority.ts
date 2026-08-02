import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

interface Evidence {
  file: string;
  includes: readonly string[];
  meaning: string;
}

const evidence: readonly Evidence[] = [
  {
    file: "crates/state-authority/src/lib.rs",
    includes: ["pub struct StateMutationAuthority", "pub struct StateMutationPermit"],
    meaning: "Shared Rust owns cross-domain mutation admission",
  },
  {
    file: "crates/runtime/src/application_order.rs",
    includes: ["pub struct ApplicationSnapshotOrder", "pub authority_id: String"],
    meaning: "Shared Rust defines the transport-neutral application ordering envelope",
  },
  {
    file: "crates/desktop-bridge/src/snapshot_order.rs",
    includes: ["pub(crate) enum SnapshotStream", "pub(crate) fn begin"],
    meaning: "the current ordering issuer remains inside the desktop bridge",
  },
  {
    file: "crates/runtime/src/capture.rs",
    includes: ["pub struct CaptureOperation", "pub struct CaptureReconciler"],
    meaning: "Shared Rust owns aggregate capture operation and reconciliation semantics",
  },
  {
    file: "crates/runtime/src/recent_traffic.rs",
    includes: ["pub struct RecentTrafficSnapshot", "pub struct RecentTraffic"],
    meaning: "Shared Rust owns recent capture-session Traffic",
  },
  {
    file: "crates/profile/src/selection.rs",
    includes: ["pub struct ProfileSelectionSnapshot", "commit_selection"],
    meaning: "Shared Rust owns selected Profile identity and revision",
  },
  {
    file: "crates/profile/src/routes.rs",
    includes: ["pub struct ProfileRouteCatalog", "profile_route_catalog"],
    meaning: "Shared Rust owns configured Profile route derivation",
  },
  {
    file: "crates/desktop-bridge/src/profile_activation.rs",
    includes: ["pub struct ProfileActivationCoordinator", "shutdown"],
    meaning: "Profile activation semantics are Rust but currently desktop-bridge-composed",
  },
  {
    file: "crates/runtime/src/traffic.rs",
    includes: ["pub struct TrafficDataSnapshot", "pub struct TrafficCommandAuthority"],
    meaning: "Shared Rust owns detailed Traffic identity and command preconditions",
  },
  {
    file: "crates/runtime/src/events.rs",
    includes: ["pub struct EventsSnapshot", "pub sequence: u64"],
    meaning: "Shared Rust owns Events source identity and order",
  },
  {
    file: "crates/runtime/src/notifications.rs",
    includes: ["pub struct NotificationCenter", "NOTIFICATION_RETENTION_LIMIT"],
    meaning: "Shared Rust owns semantic notification authority and retention",
  },
  {
    file: "crates/settings/src/lib.rs",
    includes: ["pub struct SettingsService", "pub trait SettingsRepository"],
    meaning: "Shared Rust owns durable settings policy and its persistence boundary",
  },
  {
    file: "crates/updater/src/service.rs",
    includes: ["pub struct UpdaterService", "pub operation_id: Option<String>"],
    meaning: "Shared Rust owns updater operation identity and persistent candidate policy",
  },
  {
    file: "crates/desktop-bridge/src/server.rs",
    includes: [
      "pub async fn start_loopback_server",
      "The Mish desktop bridge may only bind to a loopback address",
      "WebSocketUpgrade",
    ],
    meaning: "the loopback RPC and WebSocket server is explicitly a desktop adapter",
  },
  {
    file: "apps/mobile/src-tauri/plugins/mish-vpn/src/lifecycle.rs",
    includes: [
      "pub(crate) struct LifecycleState",
      "impl Machine for LifecycleMachine",
      "pub authority_id: String",
      "pub sequence: u64",
    ],
    meaning: "Shared Rust owns the Android fixture lifecycle and ordering authority",
  },
  {
    file: "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/java/com/asuka109/mish/vpn/MishVpnStateStore.kt",
    includes: [
      "internal class MishVpnPlatformStore",
      "getSharedPreferences",
      "foregroundExpected",
      "serviceInstanceId",
    ],
    meaning: "Android persists only the minimum platform recovery evidence",
  },
  {
    file: "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/java/com/asuka109/mish/vpn/MishVpnPlugin.kt",
    includes: ["class MishVpnPlugin", "VpnService.prepare(activity)", "startPlatformLifecycle"],
    meaning: "the Android plugin owns permission and service command projection",
  },
  {
    file: "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/java/com/asuka109/mish/vpn/MishVpnService.kt",
    includes: [
      "class MishVpnService : VpnService()",
      "override fun onRevoke()",
      "override fun onDestroy()",
    ],
    meaning: "Android owns foreground-service and platform lifecycle callbacks",
  },
  {
    file: "apps/mobile/src-tauri/plugins/mish-vpn/src/models.rs",
    includes: [
      "pub struct MobileVpnSnapshot",
      "pub authority_id: String",
      "pub session_id: String",
      "pub revision: u64",
    ],
    meaning: "Rust projects the complete mobile authority snapshot at the Tauri boundary",
  },
  {
    file: "packages/contracts/src/index.ts",
    includes: ["export const MobileVpnSnapshotSchema", "export const MobileVpnEventSchema"],
    meaning: "the mobile snapshot is duplicated at the TypeScript validation boundary",
  },
  {
    file: "apps/web/src/platform/mobile-vpn-client.ts",
    includes: [
      "export class MobileVpnFixtureClient",
      "private acceptBaseline",
      "this.retiredAuthorityIds.has(snapshot.authorityId)",
      "snapshot.sequence <= this.snapshot.sequence",
    ],
    meaning: "the mobile client requires a baseline and rejects stale authorities and sequences",
  },
  {
    file: "apps/web/src/platform/mobile-runtime-bootstrap.ts",
    includes: [
      "class MobileFixtureStatusClient",
      "new FixtureProfileClient()",
      'runtime: "mobile"',
    ],
    meaning: "mobile product domains are currently explicit TypeScript fixtures",
  },
  {
    file: "mobile-core/abi/mish_mobile_core.h",
    includes: ["mish_core_start_v1", "mish_core_stop_v1", "mish_core_free_buffer_v1"],
    meaning: "Mobile Core exposes a closed engine ABI and explicit buffer release",
  },
  {
    file: "apps/web/src/app.tsx",
    includes: ["ProductRoutes shell={<AppShell />}"],
    meaning: "desktop has a dedicated React composition",
  },
  {
    file: "apps/web/src/mobile-app.tsx",
    includes: ["<MobileShell", "vpnClient={mobileVpnClient}"],
    meaning: "mobile has a dedicated React composition",
  },
];

const contractFile = "docs/architecture/cross-platform-product-authority.md";
const requiredSections = [
  "## Decision and evidence baseline",
  "## State-scope taxonomy",
  "## Evidence-backed ownership matrix",
  "## Risk register and migration rules",
  "## Canonical dependency graph",
  "## Exact follow-up Issue draft set",
  "## Rejected alternatives",
  "## Persistence and compatibility policy",
  "## Contract checks and closure",
] as const;
const scopes = [
  "`process-global`",
  "`runtime-scoped`",
  "`Profile-scoped`",
  "`capture/Traffic session-scoped`",
  "`platform-scoped`",
  "`durable installation state`",
  "`view-local`",
] as const;
const rowIds = [
  "A01",
  "A02",
  "S01",
  "S02",
  "S03",
  "S04",
  "P01",
  "P02",
  "P03",
  "R01",
  "R02",
  "T01",
  "T02",
  "T03",
  "E01",
  "E02",
  "G01",
  "G02",
  "N01",
  "N02",
  "U01",
  "U02",
  "L01",
  "L02",
  "B01",
  "M01",
  "M02",
  "M03",
  "M04",
  "M05",
  "M06",
  "V01",
] as const;
const boundaryTerms = [
  "**Shared Rust**",
  "**Platform adapters**",
  "**React**",
  "Mobile never starts or embeds the desktop loopback bridge",
  "Shared Rust command results carry operation identity",
  "None is a horizontal",
] as const;

const failures: string[] = [];

const forbiddenMobileAuthorityFiles = [
  "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/java/com/asuka109/mish/vpn/MishVpnBackend.kt",
  "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/java/com/asuka109/mish/vpn/MishVpnStateMachine.kt",
] as const;

function inspect(file: string, requiredText: readonly string[]) {
  const content = readFileSync(resolve(repositoryRoot, file), "utf8");
  for (const text of requiredText) {
    if (!content.includes(text))
      failures.push(`${file} no longer contains ${JSON.stringify(text)}`);
  }
}

for (const item of evidence) inspect(item.file, item.includes);
for (const file of forbiddenMobileAuthorityFiles) {
  if (existsSync(resolve(repositoryRoot, file))) {
    failures.push(`${file} must not restore Kotlin-owned product lifecycle authority`);
  }
}
inspect(contractFile, [
  ...requiredSections,
  ...scopes,
  ...rowIds.map((id) => `\`${id}\``),
  ...boundaryTerms,
]);
inspect("docs/README.md", ["cross-platform-product-authority.md"]);
inspect("docs/current-state.md", ["cross-platform-product-authority.md"]);
inspect("package.json", ["node scripts/check-cross-platform-authority.ts"]);

const mobileBootstrap = readFileSync(
  resolve(repositoryRoot, "apps/web/src/platform/mobile-runtime-bootstrap.ts"),
  "utf8",
);
if (mobileBootstrap.includes('invoke("runtime_bootstrap")')) {
  failures.push("mobile runtime bootstrap must not invoke the desktop runtime_bootstrap command");
}
if (mobileBootstrap.includes("createBrowserWebSocketTransportFactory")) {
  failures.push("mobile runtime bootstrap must not construct the desktop WebSocket transport");
}

if (failures.length > 0) {
  console.error("Cross-platform product authority inspection failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`Update ${contractFile} and this inspection when the boundary changes.`);
  process.exitCode = 1;
} else {
  console.log(
    `Cross-platform product authority inspection passed (${evidence.length} evidence groups, ${rowIds.length} matrix rows).`,
  );
}
