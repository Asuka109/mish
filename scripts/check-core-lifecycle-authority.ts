import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function productionSources(root: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(resolve(repositoryRoot, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "tests") visit(path);
        continue;
      }
      if (
        /\.(?:c|go|h|kt|rs|ts|tsx)$/u.test(entry.name) &&
        !/(?:^|[._-])test\./u.test(entry.name)
      ) {
        entries.push([path, source(path)]);
      }
    }
  };
  visit(root);
  return entries;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function checkCoreLifecycleAuthority(): void {
  const runtime = source("crates/runtime/src/lib.rs");
  const runtimeHost = source("crates/desktop-bridge/src/runtime_host.rs");
  const managedProcess = source("crates/desktop-bridge/src/managed_process.rs");
  const protocol = source("crates/desktop-bridge/src/protocol.rs");
  const contracts = source("packages/contracts/src/index.ts");
  const server = source("crates/desktop-bridge/src/server.rs");
  const profile = source("crates/desktop-bridge/src/profile_activation.rs");
  const mobileRust = source("apps/mobile/src-tauri/plugins/mish-vpn/src/android.rs");
  const mobileKotlin = source(
    "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/java/com/asuka109/mish/vpn/MishMobileCoreProbe.kt",
  );
  const mobileService = source(
    "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/java/com/asuka109/mish/vpn/MishVpnService.kt",
  );
  const mobileCore = source("mobile-core/wrapper/runtime.go");
  const productSources = ["apps", "crates", "mobile-core", "packages"].flatMap(productionSources);

  const coreTrait = runtime.slice(
    runtime.indexOf("pub trait CoreRuntime"),
    runtime.indexOf("pub trait StatusDataSource"),
  );
  invariant(
    coreTrait.includes("execute_lifecycle"),
    "CoreRuntime must accept scoped lifecycle commands.",
  );
  invariant(
    !/fn\s+(start|stop)\s*\(/u.test(coreTrait),
    "CoreRuntime exposes a bare start/stop method.",
  );
  invariant(
    !runtime.includes("publish_current_status"),
    "Runtime exposes terminal publication without owned lifecycle finalization.",
  );
  for (const field of [
    "machine_authority",
    "scope_epoch",
    "operation_id",
    "admitted_revision",
    "effect_identity",
  ]) {
    invariant(runtime.includes(field), `Desktop Core lifecycle is missing ${field}.`);
    invariant(mobileRust.includes(field), `Android adapter is missing ${field}.`);
  }
  invariant(
    runtime.includes("finalize_core_lifecycle(&command)") &&
      runtime.includes("let observed = self.core.status().await") &&
      runtime.includes("CorePhase::Running | CorePhase::Stopped") &&
      runtime.includes("pub struct StatusProjectionEventSink") &&
      runtime.includes("authority high-water mark"),
    "Terminal Core publication must follow owned finalization and authoritative observation.",
  );
  for (const [path, contents] of productSources) {
    if (
      path !== "crates/runtime/src/lib.rs" &&
      path !== "crates/desktop-bridge/src/profile_activation.rs"
    ) {
      invariant(
        !contents.includes("CoreLifecycleOperation::new"),
        `${path} can mint Core lifecycle authority outside the Profile coordinator.`,
      );
    }
    if (
      path !== "crates/runtime/src/lib.rs" &&
      path !== "crates/desktop-bridge/src/activation.rs"
    ) {
      invariant(
        !contents.includes("execute_core_lifecycle("),
        `${path} mutates Core outside the coordinator-owned activation adapter.`,
      );
    }
  }
  invariant(
    !runtimeHost.includes("pub async fn start_core") &&
      !runtimeHost.includes("pub async fn stop_core"),
    "DesktopRuntimeHost exposes a bare Core mutation.",
  );
  invariant(
    !managedProcess.includes("pub async fn start(&self)") &&
      !managedProcess.includes("pub async fn stop(&self)"),
    "DesktopMihomoProcess exposes a public bare Core mutation.",
  );
  invariant(
    !protocol.includes('"core.start" =>') && !protocol.includes('"core.stop" =>'),
    "Desktop Bridge exposes a bare Core mutation RPC.",
  );
  invariant(
    !contracts.includes('"core.start"') && !contracts.includes('"core.stop"'),
    "Shared TypeScript contracts expose a bare Core mutation RPC.",
  );
  invariant(
    server.includes("shutdown_observers().await") && !server.includes("current().shutdown().await"),
    "Bridge teardown must delegate Core shutdown to the Profile coordinator.",
  );
  invariant(
    server.indexOf("report.rpc_closed = true;") >= 0 &&
      server.indexOf("report.rpc_closed = true;") <
        server.indexOf("runtime.confirm_transport_shutdown_safe().await"),
    "Bridge teardown must close and drain RPC admission before transport-only safety proof.",
  );
  invariant(
    profile.includes("CoreLifecycleOperation::new") &&
      profile.includes("recover_managed_startup") &&
      profile.includes("record_managed_safe_stopped"),
    "Profile coordinator does not own startup recovery and Core lifecycle admission.",
  );
  invariant(
    mobileKotlin.includes("CoreLifecycleAuthority") &&
      mobileKotlin.includes("fun nextEffect()") &&
      mobileCore.includes("validateLifecycleAuthority") &&
      mobileCore.includes("lifecycleSuccessor") &&
      mobileCore.includes("strconv.ParseUint(current.EffectIdentity, 10, 64)") &&
      !mobileCore.includes('current.EffectIdentity+".cleanup"'),
    "Mobile Core mutations are not validating coordinator authority.",
  );
  const mobileNotification = mobileService.slice(
    mobileService.indexOf("private fun buildNotification"),
    mobileService.indexOf("private fun createNotificationChannel"),
  );
  invariant(
    !mobileNotification.includes("ACTION_STOP") &&
      !mobileNotification.includes("PendingIntent.getService"),
    "Android notification exposes a bare Core stop outside the Shared Rust coordinator.",
  );
}

if (process.argv[1] === import.meta.filename) {
  checkCoreLifecycleAuthority();
  console.log(
    "Core lifecycle authority valid: coordinator-only mutations and observed terminal publication.",
  );
}
