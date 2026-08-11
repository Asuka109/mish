import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const rpcSessionConsumerFiles = [
  "apps/web/src/data/rpc-status-client.ts",
  "apps/web/src/data/rpc-traffic-client.ts",
  "apps/web/src/data/rpc-updater-client.ts",
  "apps/web/src/data/rpc-profile-client.ts",
  "apps/web/src/data/rpc-settings-client.ts",
  "apps/web/src/data/rpc-notification-client.ts",
  "apps/web/src/data/rpc-events-client.ts",
  "apps/web/src/data/product-provider.tsx",
  "apps/web/src/data/traffic-provider.tsx",
  "apps/web/src/data/profile-provider.tsx",
  "apps/web/src/data/settings-provider.tsx",
  "apps/web/src/data/events-provider.tsx",
  "apps/web/src/data/notification-delivery.tsx",
  "apps/web/src/platform/mobile-settings-client.ts",
] as const;

export const rpcSessionContractFiles = [
  "docs/architecture/rpc-session-authority.md",
  "docs/README.md",
  "docs/current-state.md",
  "docs/architecture/bridge-protocol-contract.md",
  "package.json",
] as const;

export const retiredRpcAuthorityFiles = [
  "apps/web/src/data/application-snapshot-acceptance.ts",
  "apps/web/src/data/application-snapshot-acceptance.test.ts",
] as const;

const forbiddenConsumerPatterns = [
  ["ApplicationSnapshotAcceptance", "legacy local snapshot authority"],
  ["snapshotAcceptance", "local snapshot acceptance state"],
  ["ticket.generation", "consumer-side generation comparison"],
  ["getGeneration(", "consumer-side generation inspection"],
  ["armReconnect(", "consumer-owned reconnect barrier"],
  ["confirmReconnect(", "consumer-owned reconnect confirmation"],
  ["isReconnectPending(", "consumer-owned reconnect state"],
] as const;

const localApplicationOrderComparison =
  /applicationOrder\.(?:authorityId|epoch|order)\s*(?:===|!==|<=|>=|<|>)/u;
const documentedProfileAuthorityProjection =
  "nextSnapshot.applicationOrder.authorityId !== current.applicationOrder.authorityId;";
const documentedProfileOrderProjection =
  /function hasSameApplicationOrder\(left: ProfileSnapshotDto, right: ProfileSnapshotDto\) \{[\s\S]*?\n\}/u;

const requiredContractText = [
  "# RPC Session Authority Contract",
  "## Boundary and ownership",
  "## Acceptance pipeline",
  "## Consumer rules",
  "## Deliberate domain and platform exceptions",
  "## Deterministic evidence and limits",
  "## Maintenance gate",
  "RpcSessionAuthority",
  "ticket.generation",
  "baseline barrier",
  "equal-order conflict",
  "real macOS, TUN, signing, notarization, release, physical-device",
] as const;

const failures: string[] = [];

export type RpcSessionAuthoritySources = Readonly<Record<string, string | undefined>>;

export function readRepositorySource(path: string): string | undefined {
  const absolutePath = resolve(repositoryRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : undefined;
}

export function validateRpcSessionAuthorityContract(sources: RpcSessionAuthoritySources): string[] {
  const errors: string[] = [];
  const sourceFor = (path: string) => sources[path];

  for (const path of rpcSessionConsumerFiles) {
    const source = sourceFor(path);
    if (source === undefined) {
      errors.push(`${path} is missing from the RPC session authority inventory`);
      continue;
    }
    if (!source.includes("RpcSessionAuthority")) {
      errors.push(`${path} must use RpcSessionAuthority`);
    }
    if (!source.includes(".accept(")) {
      errors.push(`${path} must pass deliveries through RpcSessionAuthority.accept`);
    }
    for (const [marker, meaning] of forbiddenConsumerPatterns) {
      if (source.includes(marker)) errors.push(`${path} contains ${meaning}: ${marker}`);
    }
    let sourceWithoutDocumentedProjection =
      path === "apps/web/src/data/profile-provider.tsx"
        ? source.replace(documentedProfileAuthorityProjection, "")
        : source;
    if (path === "apps/web/src/data/profile-provider.tsx") {
      sourceWithoutDocumentedProjection = sourceWithoutDocumentedProjection.replace(
        documentedProfileOrderProjection,
        "",
      );
    }
    if (localApplicationOrderComparison.test(sourceWithoutDocumentedProjection)) {
      errors.push(`${path} contains a consumer-side application-order comparison`);
    }
  }

  for (const path of retiredRpcAuthorityFiles) {
    if (sourceFor(path) !== undefined) errors.push(`${path} must remain deleted`);
  }

  const contract = sourceFor("docs/architecture/rpc-session-authority.md");
  if (contract === undefined) {
    errors.push("docs/architecture/rpc-session-authority.md is missing");
  } else {
    for (const text of requiredContractText) {
      if (!contract.includes(text)) {
        errors.push(`rpc-session-authority.md no longer contains ${JSON.stringify(text)}`);
      }
    }
  }

  const readme = sourceFor("docs/README.md");
  if (readme === undefined || !readme.includes("rpc-session-authority.md")) {
    errors.push("docs/README.md must index rpc-session-authority.md");
  }
  const currentState = sourceFor("docs/current-state.md");
  if (currentState === undefined || !currentState.includes("rpc-session-authority.md")) {
    errors.push("docs/current-state.md must link the RPC session authority contract");
  }
  const bridgeContract = sourceFor("docs/architecture/bridge-protocol-contract.md");
  if (bridgeContract === undefined || !bridgeContract.includes("rpc-session-authority.md")) {
    errors.push("bridge-protocol-contract.md must link the RPC session authority contract");
  }

  const packageManifest = sourceFor("package.json");
  if (
    packageManifest === undefined ||
    !packageManifest.includes("check-rpc-session-authority.ts")
  ) {
    errors.push("package.json must run the RPC session authority gate");
  }

  return errors;
}

function repositorySources(): Record<string, string | undefined> {
  const paths = [
    ...rpcSessionConsumerFiles,
    ...rpcSessionContractFiles,
    ...retiredRpcAuthorityFiles,
  ];
  return Object.fromEntries(paths.map((path) => [path, readRepositorySource(path)]));
}

export function checkRpcSessionAuthority(): void {
  failures.length = 0;
  failures.push(...validateRpcSessionAuthorityContract(repositorySources()));
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

if (process.argv[1] === import.meta.filename) {
  checkRpcSessionAuthority();
  console.log("RPC session authority contract valid: one shared acceptance policy is enforced.");
}
