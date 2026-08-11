import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const testProjectionSource = ["crates", "simulated-host", "src", "lib.rs"].join("/");

export interface Evidence {
  file: string;
  includes: readonly string[];
  meaning: string;
}

export type SourceReader = (relativePath: string) => string | null;

export const evidence: readonly Evidence[] = [
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
  {
    file: "crates/state-machine/src/lib.rs",
    includes: [
      "pub enum ForcedRetirementReason",
      "fn finish_effect",
      "async fn drain<",
      "pub fn abort_for_process_termination",
      "pub enum RetirementTerminal",
    ],
    meaning:
      "the repository kernel owns bounded completion, forced retirement, and shutdown mechanics",
  },
  {
    file: "crates/runtime/src/capture.rs",
    includes: [
      "runner: RunnerHandle<CaptureMachine>",
      "let runner = spawn_runner(",
      "pub async fn reconcile_for_shutdown",
      "self.runner.shutdown().await",
      "pub struct CaptureRuntimeTransition",
    ],
    meaning:
      "CaptureReconciler exposes one runner and keeps replacement admission separate from lifecycle ownership",
  },
  {
    file: "crates/runtime/src/capture/machine.rs",
    includes: [
      "impl Machine for CaptureMachine",
      "fn finalizer(",
      "CaptureEffect::Finalize",
      "CaptureInput::TaskFailed",
      "fn task_failed(&self, correlation: Correlation, failure: TaskFailure)",
    ],
    meaning: "CaptureMachine owns typed replacement, failure, and finalization transitions",
  },
  {
    file: testProjectionSource,
    includes: ["CaptureLifecycleObserver", "capture.set_lifecycle_observer(observer)"],
    meaning: "SimulatedHost records a bounded transcript projection and is not a lifecycle owner",
  },
  {
    file: "docs/architecture/state-machine-registry.json",
    includes: [
      '"schemaVersion": 2',
      '"id": "capture-owned-operation-lifecycle"',
      '"lifecycleAuthority": "capture-owned-operation-lifecycle"',
    ],
    meaning: "the registry records the single Capture lifecycle authority and machine binding",
  },
];

const contractFile = "docs/architecture/runtime-state-ownership.md";
const contractSections = [
  "## Ownership taxonomy",
  "## Capture owned-operation authority",
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
  "capture-owned-operation-lifecycle",
  "forced retirement",
  "cancellation",
  "finalization",
  "runtime replacement",
  "shutdown",
  "explicitly non-owners",
] as const;

const lifecycleDocumentation: readonly Evidence[] = [
  {
    file: "docs/architecture/state-machine-kernel.md",
    includes: [
      "## Single lifecycle authority for Capture owned operations",
      "reserves replacement admission; it does not cancel or finalize",
      "inspection fail closed when an owner path",
    ],
    meaning: "the kernel contract assigns each Capture lifecycle responsibility to one owner",
  },
  {
    file: "docs/architecture/state-lifecycle-race-audit.md",
    includes: [
      "The lifecycle authority is recorded once as",
      "module may construct a Capture runner",
      "CaptureLifecycleObserver` projection are non-owners.",
    ],
    meaning:
      "the race audit preserves the single authority through replacement, shutdown, and projection",
  },
];

export function readRepositorySource(relativePath: string): string | null {
  try {
    return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
  } catch {
    return null;
  }
}

function inspect(
  failures: string[],
  readSource: SourceReader,
  file: string,
  requiredText: readonly string[],
): void {
  const content = readSource(file);
  for (const text of requiredText) {
    if (content === null || !content.includes(text)) {
      failures.push(`${file} no longer contains ${JSON.stringify(text)}`);
    }
  }
}

export function validateRuntimeStateOwnership(
  readSource: SourceReader = readRepositorySource,
): string[] {
  const failures: string[] = [];
  for (const item of evidence) inspect(failures, readSource, item.file, item.includes);
  for (const item of lifecycleDocumentation) {
    inspect(failures, readSource, item.file, item.includes);
  }
  inspect(failures, readSource, contractFile, [...contractSections, ...contractTerms]);
  return failures;
}

export function checkRuntimeStateOwnership(): void {
  const failures = validateRuntimeStateOwnership();
  if (failures.length > 0) {
    console.error("Runtime state ownership inspection failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    console.error(`Update ${contractFile} and this inspection when ownership changes.`);
    process.exitCode = 1;
  } else {
    console.log(
      `Runtime state ownership inspection passed (${evidence.length + lifecycleDocumentation.length} evidence groups).`,
    );
  }
}

if (process.argv[1] === import.meta.filename) checkRuntimeStateOwnership();
