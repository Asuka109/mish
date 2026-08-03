import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

interface Evidence {
  file: string;
  includes: readonly string[];
  meaning: string;
}

const evidence: readonly Evidence[] = [
  {
    file: "apps/desktop/src-tauri/src/lib.rs",
    includes: [
      "The managed backend must retain an App-owned Core executable.",
      "fn managed_core_startup_binary(",
      "privileged_tun_availability_never_replaces_the_managed_core_binary",
      "managed_core_binary,",
    ],
    meaning: "Helper maintenance cannot replace the executable owned by the ordinary managed Core",
  },
  {
    file: "crates/platform-macos/src/tun_service.rs",
    includes: [
      "fn privileged_core_launch_binary(&self, requested: &Path) -> PathBuf",
      "PathBuf::from(DEV_TUN_SERVICE_CORE_PATH)",
    ],
    meaning: "only the privileged TUN host substitutes the installed pinned Core",
  },
  {
    file: "crates/runtime/src/recent_traffic.rs",
    includes: [
      "pub struct RecentTrafficSnapshot",
      "pub enum RecentTrafficContinuity",
      "RECENT_TRAFFIC_SAMPLE_LIMIT: usize = 60",
    ],
    meaning: "Rust owns the current Status capture-session authority and bounded paired history",
  },
  {
    file: "crates/runtime/src/status.rs",
    includes: ["pub const STATUS_TRAFFIC_SERIES_LIMIT: usize = 512;", "pub struct TrafficSnapshot"],
    meaning: "Rust exposes the low-level bounded Status Traffic source",
  },
  {
    file: "crates/desktop-bridge/src/controller_status.rs",
    includes: [
      "self.traffic.downloaded_bytes = downloaded_bytes;",
      "self.retention.max_traffic_samples",
    ],
    meaning: "the Controller mapper owns cumulative source observations and retention",
  },
  {
    file: "crates/runtime/src/traffic.rs",
    includes: [
      "pub struct TrafficDataSnapshot",
      "pub sequence: u64",
      "pub session_id: Option<String>",
    ],
    meaning: "detailed Traffic has Rust source identity and order",
  },
  {
    file: "crates/profile/src/selection.rs",
    includes: [
      "pub struct ProfileSelectionSnapshot",
      'root.join("selected-profile.json")',
      "commit_selection",
    ],
    meaning: "Rust owns persisted selected Profile identity and revision",
  },
  {
    file: "apps/web/src/data/profile-provider.tsx",
    includes: [
      "nextSnapshot.selection.revision < current.selection.revision",
      "selectionProjection",
      "useCommandFeedback",
      "expectedSelection",
    ],
    meaning:
      "Web keeps only an ordered confirmed snapshot, temporary optimistic projection, and revision-bound rollback",
  },
  {
    file: "apps/web/src/data/command-feedback.ts",
    includes: [
      "export function commandFeedbackReducer",
      '"cancelled"',
      '"disconnected"',
      '"superseded"',
      "matchesPendingOperation",
    ],
    meaning:
      "one Web Module owns operation/domain/scope identity, legal terminal phases, and exact cleanup",
  },
  {
    file: "apps/web/src/data/product-provider.tsx",
    includes: ["useCommandFeedback", "captureCommandAuthority", "isCurrentCommandFeedback"],
    meaning: "Product feedback composes application and Capture identities",
  },
  {
    file: "apps/web/src/data/traffic-provider.tsx",
    includes: ["useCommandFeedback", "trafficCommandScope", "latestTrafficOperation"],
    meaning: "Traffic feedback keeps target payloads outside exact operation and scope state",
  },
  {
    file: "apps/web/src/data/events-provider.tsx",
    includes: ["useCommandFeedback", "eventsCommandScope", "supportBundlePending"],
    meaning: "Events support-bundle commands use exact operation feedback",
  },
  {
    file: "crates/runtime/src/notifications.rs",
    includes: [
      "pub const NOTIFICATION_RETENTION_LIMIT: usize = 128;",
      "authoritative in-process Module for notification identity, ordering, retention",
      "pub struct NotificationSnapshot",
    ],
    meaning: "notification identity, revision, and retention are Rust authority",
  },
  {
    file: "crates/runtime/src/events.rs",
    includes: ["pub struct EventsSnapshot", "pub sequence: u64", "pub session_id: Option<String>"],
    meaning: "Events source identity and order are Rust authority",
  },
  {
    file: "apps/web/src/pages/events-model.ts",
    includes: ["export const EVENTS_LOCAL_BUFFER_LIMIT = 1_024;", "reconcileEventsSnapshot"],
    meaning: "the rendered Events history is a bounded Web cache",
  },
  {
    file: "apps/web/src/data/traffic-provider.tsx",
    includes: ["processIconCacheRef", "processIconCacheRef.current.size >= 128", "latestSnapshot"],
    meaning: "Traffic keeps bounded reconstructible Web caches separate from command authority",
  },
  {
    file: "apps/web/src/data/settings-provider.tsx",
    includes: ["SettingsLanguageProjection", "Rust-authoritative language"],
    meaning: "Web language is a projection of the Rust Settings authority",
  },
];

const contractFile = "docs/architecture/runtime-state-ownership.md";
const contractSections = [
  "## Ownership taxonomy",
  "## Evidence-backed ownership matrix",
  "## Resolved recent-Traffic divergence",
  "## Implemented recent capture-session Traffic Interface",
  "### Identity, revision, and order",
  "### Cadence and bounded window",
  "### Totals and baselines",
  "### Reset and lifecycle rules",
  "### Persistence, privacy, and retention",
  "### Compatibility and cutover",
  "## Migration slices",
  "## Acceptance inventory",
] as const;
const contractTerms = [
  "**Authority**",
  "**Derived DTO**",
  "**Bounded cache**",
  "**Optimistic projection**",
  "**Presentation-only**",
] as const;

const failures: string[] = [];

function inspect(file: string, requiredText: readonly string[]) {
  const content = readFileSync(resolve(repositoryRoot, file), "utf8");
  for (const text of requiredText) {
    if (!content.includes(text))
      failures.push(`${file} no longer contains ${JSON.stringify(text)}`);
  }
}

for (const item of evidence) {
  inspect(item.file, item.includes);
}
inspect(contractFile, [...contractSections, ...contractTerms]);

if (failures.length > 0) {
  console.error("Runtime state ownership inspection failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`Update ${contractFile} and this inspection when ownership changes.`);
  process.exitCode = 1;
} else {
  console.log(`Runtime state ownership inspection passed (${evidence.length} evidence groups).`);
}
