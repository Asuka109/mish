import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import {
  access,
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { accessSync, constants as syncConstants, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

type MacOsMihomoRelease = {
  archiveSha256: string;
  asset: string;
  binarySha256: string;
  repository: string;
  schemaVersion: 1;
  version: string;
};

type InstallerFailureKind =
  | "authorization-cancelled"
  | "installation-failed"
  | "preparation-failed";

type InstallerResult =
  | {
      generation?: number;
      installation?: DevelopmentTunInstallationClassification["installation"];
      installationId?: string;
      installedVersion?: string;
      keyId?: string;
      ok: true;
      operation?: string;
      reason?: DevelopmentTunInstallationClassification["reason"];
      service?: "installed" | "not-installed";
      stage: "completed" | "prepared" | "status";
    }
  | { code: string; kind: InstallerFailureKind; ok: false; stage: string };

class InstallerFailure extends Error {
  readonly code: string;
  readonly kind: InstallerFailureKind;
  readonly stage: string;

  constructor(kind: InstallerFailureKind, stage: string, code: string) {
    super(`${stage}: ${code}`);
    this.code = code;
    this.kind = kind;
    this.stage = stage;
  }
}

const label = "com.asuka109.mish.tun-helper.dev";
const helperTarget = `/Library/PrivilegedHelperTools/${label}`;
const helperDirectory = path.dirname(helperTarget);
const coreTarget = "/Library/PrivilegedHelperTools/com.asuka109.mish.mihomo.dev";
const plistTarget = `/Library/LaunchDaemons/${label}.plist`;
const enrollmentDirectory = "/Library/Application Support/com.asuka109.mish/tun-helper-dev";
const enrollmentTarget = path.join(enrollmentDirectory, "enrollment.json");
const releaseManifestPath = path.resolve("resources/mihomo/macos-arm64.json");
const runtimeRoot = path.join(
  os.homedir(),
  "Library/Application Support/com.asuka109.mish/runtime",
);
const installerRoot = path.join(runtimeRoot, "tun-service-installer");
const plist = path.join(installerRoot, `${label}.plist`);
const resultReceipt = path.join(installerRoot, "last-result.json");
export const clientKeyPath = path.join(runtimeRoot, "tun-client-key.json");
export const pendingClientKeyPath = path.join(runtimeRoot, "tun-client-key.pending.json");
const enrollmentCandidatePath = path.join(installerRoot, "enrollment.json");
const pendingEnrollmentCandidatePath = path.join(installerRoot, "enrollment.pending.json");
const rotationRequestPath = path.join(installerRoot, "rotation.json");
const installationKeyAlgorithm = "p256-sha256";
const installationKeyRecordVersion = 1;
const installationKeyTranscriptVersion = 1;
const tunHelperExpectedVersion = "6";
const tunHelperProtocolVersion = 3;

type InstallationClientKeyRecord = {
  algorithm: "p256-sha256";
  keyId: string;
  privateKeyPkcs8: string;
  publicKeySpki: string;
  schemaVersion: 1;
};

type InstallationPublicKeyCandidate = {
  algorithm: "p256-sha256";
  helperInstallationId: string;
  installingUid: number;
  keyId: string;
  publicKeySpki: string;
  schemaVersion: 1;
};

type InstallationKeyRotationRequest = {
  algorithm: "p256-sha256";
  currentGeneration: number;
  currentKeyId: string;
  helperInstallationId: string;
  installingUid: number;
  newSignature: string;
  oldSignature: string;
  replacementKeyId: string;
  replacementPublicKeySpki: string;
  schemaVersion: 1;
  transcriptVersion: 1;
};

type InstallationDiscovery = {
  algorithm: string;
  generation: number;
  helperVersion: string;
  installationId: string;
  keyId: string;
  protocolVersion: number;
};

export type DevelopmentTunInstallationObservation = {
  artifacts: "absent" | "ambiguous" | "foreign" | "mish-owned" | "partial";
  clientIdentity: "invalid" | "missing" | "pending-commit" | "present";
  discovery: "matching" | "mismatched" | "missing" | "protocol-mismatch" | "version-mismatch";
  enrollmentIdentity:
    | "invalid"
    | "matches-client"
    | "mismatches-client"
    | "missing"
    | "stale-installation";
  service: "not-running" | "running";
};

export type DevelopmentTunInstallationClassification = {
  installation: "installed" | "not-installed" | "recovery-required" | "repair-required";
  reason:
    | "ambiguous-artifacts"
    | "clean-absence"
    | "client-enrollment-mismatch"
    | "foreign-artifacts"
    | "healthy"
    | "installation-identity-mismatch"
    | "invalid-client-key"
    | "invalid-enrollment"
    | "missing-client-key"
    | "missing-enrollment"
    | "missing-socket"
    | "pending-client-key"
    | "partial-artifacts"
    | "protocol-mismatch"
    | "version-mismatch";
};

export function classifyDevelopmentTunInstallation(
  observation: DevelopmentTunInstallationObservation,
): DevelopmentTunInstallationClassification {
  if (
    observation.service === "not-running" &&
    observation.artifacts === "absent" &&
    observation.enrollmentIdentity === "missing" &&
    (observation.clientIdentity === "missing" || observation.clientIdentity === "present") &&
    observation.discovery === "missing"
  ) {
    return { installation: "not-installed", reason: "clean-absence" };
  }
  if (observation.artifacts === "foreign" || observation.artifacts === "ambiguous") {
    return {
      installation: "recovery-required",
      reason: observation.artifacts === "foreign" ? "foreign-artifacts" : "ambiguous-artifacts",
    };
  }
  if (observation.clientIdentity === "invalid") {
    return { installation: "recovery-required", reason: "invalid-client-key" };
  }
  if (observation.enrollmentIdentity === "invalid") {
    return { installation: "recovery-required", reason: "invalid-enrollment" };
  }
  if (observation.artifacts === "mish-owned" && observation.clientIdentity === "missing") {
    return { installation: "repair-required", reason: "missing-client-key" };
  }
  if (
    observation.artifacts === "mish-owned" &&
    observation.clientIdentity === "pending-commit" &&
    observation.enrollmentIdentity === "matches-client"
  ) {
    if (observation.discovery === "matching") {
      return { installation: "repair-required", reason: "pending-client-key" };
    }
    if (observation.discovery === "version-mismatch") {
      return { installation: "repair-required", reason: "version-mismatch" };
    }
    if (observation.discovery === "protocol-mismatch") {
      return { installation: "repair-required", reason: "protocol-mismatch" };
    }
  }
  if (
    observation.artifacts === "mish-owned" &&
    observation.enrollmentIdentity === "mismatches-client"
  ) {
    return {
      installation: "recovery-required",
      reason: "client-enrollment-mismatch",
    };
  }
  if (
    observation.artifacts === "mish-owned" &&
    (observation.enrollmentIdentity === "stale-installation" ||
      (observation.enrollmentIdentity === "matches-client" &&
        observation.discovery === "mismatched"))
  ) {
    return {
      installation: "repair-required",
      reason: "installation-identity-mismatch",
    };
  }
  if (observation.artifacts === "partial") {
    return { installation: "recovery-required", reason: "partial-artifacts" };
  }
  if (
    observation.artifacts === "mish-owned" &&
    observation.clientIdentity === "present" &&
    observation.enrollmentIdentity === "matches-client" &&
    observation.discovery === "missing"
  ) {
    return { installation: "repair-required", reason: "missing-socket" };
  }
  if (
    observation.service === "running" &&
    observation.artifacts === "mish-owned" &&
    observation.enrollmentIdentity === "matches-client" &&
    observation.clientIdentity === "present"
  ) {
    if (observation.discovery === "matching") {
      return { installation: "installed", reason: "healthy" };
    }
    if (observation.discovery === "version-mismatch") {
      return { installation: "repair-required", reason: "version-mismatch" };
    }
    if (observation.discovery === "protocol-mismatch") {
      return { installation: "repair-required", reason: "protocol-mismatch" };
    }
  }
  if (
    observation.artifacts === "mish-owned" &&
    observation.enrollmentIdentity === "missing" &&
    observation.clientIdentity === "present"
  ) {
    return { installation: "repair-required", reason: "missing-enrollment" };
  }
  return { installation: "recovery-required", reason: "ambiguous-artifacts" };
}

type DevelopmentTunStatusObservation = {
  installationId?: string;
  installedVersion?: string;
  observation: DevelopmentTunInstallationObservation;
};

type DevelopmentTunSocketMetadata = {
  isSocket(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  nlink: number;
  uid: number;
};

export function safeDevelopmentTunSocketMetadata(
  socket: DevelopmentTunSocketMetadata,
  uid: number,
) {
  return (
    socket.isSocket() &&
    !socket.isSymbolicLink() &&
    socket.uid === uid &&
    (socket.mode & 0o777) === 0o600 &&
    socket.nlink === 1
  );
}

type DevelopmentTunSocketObservation = "absent" | "safe" | "unsafe";

export function classifyDevelopmentTunSocketArtifacts(
  artifacts: DevelopmentTunInstallationObservation["artifacts"],
  socket: DevelopmentTunSocketObservation,
) {
  if (artifacts === "absent") return socket === "absent" ? "absent" : "ambiguous";
  if (artifacts === "mish-owned" && socket === "unsafe") return "ambiguous";
  return artifacts;
}

async function observeDevelopmentTunSocket(
  socketPath: string,
  uid: number,
): Promise<DevelopmentTunSocketObservation> {
  try {
    const socket = await lstat(socketPath);
    return safeDevelopmentTunSocketMetadata(socket, uid) ? "safe" : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe";
  }
}

async function observeInstalledArtifacts(uid: number) {
  const targets = [
    { file: helperTarget, mode: 0o555 },
    { file: coreTarget, mode: 0o555 },
    { file: plistTarget, mode: 0o644 },
  ] as const;
  const observations = await Promise.all(
    targets.map(async ({ file, mode }) => {
      try {
        const metadata = await lstat(file);
        return {
          file,
          valid:
            metadata.isFile() &&
            !metadata.isSymbolicLink() &&
            metadata.uid === 0 &&
            (metadata.mode & 0o777) === mode &&
            metadata.nlink === 1 &&
            metadata.size > 0 &&
            metadata.size <= 128 * 1024 * 1024,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, valid: null };
        return { file, valid: false };
      }
    }),
  );
  if (observations.every(({ valid }) => valid === null)) {
    return { artifacts: "absent" as const };
  }
  if (observations.some(({ valid }) => valid === false)) {
    return { artifacts: "foreign" as const };
  }
  if (observations.some(({ valid }) => valid === null)) {
    return { artifacts: "partial" as const };
  }
  try {
    const [helper, core, installedPlist] = await Promise.all([
      readFile(helperTarget),
      readFile(coreTarget),
      readFile(plistTarget, "utf8"),
    ]);
    if (Buffer.byteLength(installedPlist) > 64 * 1024) {
      return { artifacts: "ambiguous" as const };
    }
    const installationMatch = installedPlist.match(
      /<key>MISH_TUN_SERVICE_INSTALLATION_ID<\/key><string>([a-f0-9]{64})<\/string>/u,
    );
    const expectedFragments = [
      `<key>Label</key>\n  <string>${label}</string>`,
      `<array><string>${helperTarget}</string></array>`,
      `<key>MISH_TUN_SERVICE_ALLOWED_UID</key><string>${uid}</string>`,
      `<key>MISH_TUN_SERVICE_CORE_BINARY</key><string>${coreTarget}</string>`,
      `<key>MISH_TUN_SERVICE_ENROLLMENT_RECORD</key><string>${enrollmentTarget}</string>`,
      `<key>MISH_TUN_SERVICE_SOCKET</key><string>/var/run/com.asuka109.mish.tun-helper.${uid}.sock</string>`,
    ];
    if (
      !installationMatch ||
      expectedFragments.some((fragment) => !installedPlist.includes(fragment))
    ) {
      return { artifacts: "foreign" as const };
    }
    const installationId = installationMatch[1];
    const template = installedPlist.replace(
      installationId,
      "MISH_TUN_SERVICE_INSTALLATION_ID_PLACEHOLDER",
    );
    const calculated = createHash("sha256")
      .update(helper)
      .update(core)
      .update(template)
      .digest("hex");
    return calculated === installationId
      ? { artifacts: "mish-owned" as const, installationId }
      : { artifacts: "ambiguous" as const };
  } catch {
    return { artifacts: "ambiguous" as const };
  }
}

type ObservedClientKey = Pick<InstallationClientKeyRecord, "keyId" | "publicKeySpki">;

export function selectObservedClientIdentity(
  active: ObservedClientKey | undefined,
  pending: ObservedClientKey | undefined,
  discoveredKeyId?: string,
) {
  if (pending && discoveredKeyId === pending.keyId) {
    return { clientIdentity: "pending-commit" as const, ...pending };
  }
  if (active) return { clientIdentity: "present" as const, ...active };
  return { clientIdentity: "missing" as const };
}

async function observeClientIdentities(uid: number) {
  try {
    const [active, pending] = await Promise.all([
      readObservedOptionalClientKeyRecord(clientKeyPath, uid),
      readObservedOptionalClientKeyRecord(pendingClientKeyPath, uid),
    ]);
    return { active, pending };
  } catch {
    return { clientIdentity: "invalid" as const };
  }
}

function validatePublicCandidate(value: unknown): InstallationPublicKeyCandidate {
  const candidate = value as Partial<InstallationPublicKeyCandidate>;
  if (
    typeof value !== "object" ||
    value === null ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          "algorithm",
          "helperInstallationId",
          "installingUid",
          "keyId",
          "publicKeySpki",
          "schemaVersion",
        ].sort(),
      ) ||
    candidate.schemaVersion !== installationKeyRecordVersion ||
    candidate.algorithm !== installationKeyAlgorithm ||
    !validKeyId(candidate.helperInstallationId) ||
    !Number.isSafeInteger(candidate.installingUid) ||
    !validKeyId(candidate.keyId) ||
    typeof candidate.publicKeySpki !== "string"
  ) {
    throw new Error("invalid public enrollment candidate");
  }
  return candidate as InstallationPublicKeyCandidate;
}

async function readEnrollmentCandidate(file: string, uid: number) {
  const metadata = await lstat(file);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > 16 * 1024
  ) {
    throw new Error("invalid enrollment candidate metadata");
  }
  return validatePublicCandidate(JSON.parse(await readFile(file, "utf8")));
}

async function classifyObservedEnrollment(
  file: string,
  uid: number,
  client: ObservedClientKey,
  installationId: string,
) {
  try {
    const candidate = await readEnrollmentCandidate(file, uid);
    return candidate.installingUid === uid &&
      candidate.keyId === client.keyId &&
      candidate.publicKeySpki === client.publicKeySpki
      ? candidate.helperInstallationId === installationId
        ? ("matches-client" as const)
        : ("stale-installation" as const)
      : ("mismatches-client" as const);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing" as const;
    return "invalid" as const;
  }
}

async function observeDevelopmentTunInstallation(
  uid: number,
  serviceRunning: boolean,
): Promise<DevelopmentTunStatusObservation> {
  const [artifacts, client] = await Promise.all([
    observeInstalledArtifacts(uid),
    observeClientIdentities(uid),
  ]);
  const observation: DevelopmentTunInstallationObservation = {
    artifacts: artifacts.artifacts,
    clientIdentity:
      "clientIdentity" in client
        ? client.clientIdentity
        : selectObservedClientIdentity(client.active, client.pending).clientIdentity,
    discovery: "missing",
    enrollmentIdentity: "missing",
    service: serviceRunning ? "running" : "not-running",
  };
  const socketPath = `/var/run/com.asuka109.mish.tun-helper.${uid}.sock`;
  if (artifacts.artifacts === "absent") {
    observation.artifacts = classifyDevelopmentTunSocketArtifacts(
      artifacts.artifacts,
      await observeDevelopmentTunSocket(socketPath, uid),
    );
    return { observation };
  }
  if (artifacts.artifacts !== "mish-owned" || "clientIdentity" in client) {
    return { observation };
  }
  if (client.active) {
    observation.enrollmentIdentity = await classifyObservedEnrollment(
      enrollmentCandidatePath,
      uid,
      client.active,
      artifacts.installationId,
    );
  }
  const socket = await observeDevelopmentTunSocket(socketPath, uid);
  observation.artifacts = classifyDevelopmentTunSocketArtifacts(artifacts.artifacts, socket);
  if (socket !== "safe") {
    return { observation };
  }
  try {
    let discovery: InstallationDiscovery | undefined;
    for (const protocolVersion of [tunHelperProtocolVersion, 2, 1]) {
      try {
        discovery = await discoverInstallation(
          socketPath,
          protocolVersion === tunHelperProtocolVersion ? 1_500 : 500,
          protocolVersion,
        );
        break;
      } catch {
        // Older development helpers reject a current-version discovery envelope.
        // Retry only the two known predecessors so status retains that distinction.
      }
    }
    if (!discovery) throw new Error("installation discovery unavailable");
    const selectedClient = selectObservedClientIdentity(
      client.active,
      client.pending,
      discovery.keyId,
    );
    observation.clientIdentity = selectedClient.clientIdentity;
    if (selectedClient.clientIdentity !== "missing") {
      observation.enrollmentIdentity = await classifyObservedEnrollment(
        selectedClient.clientIdentity === "pending-commit"
          ? pendingEnrollmentCandidatePath
          : enrollmentCandidatePath,
        uid,
        selectedClient,
        artifacts.installationId,
      );
    }
    observation.discovery =
      discovery.protocolVersion !== tunHelperProtocolVersion
        ? "protocol-mismatch"
        : discovery.helperVersion !== tunHelperExpectedVersion
          ? "version-mismatch"
          : discovery.installationId !== artifacts.installationId
            ? "mismatched"
            : "matching";
    if (selectedClient.clientIdentity !== "missing" && discovery.keyId !== selectedClient.keyId) {
      observation.enrollmentIdentity = "mismatches-client";
    }
    return {
      installationId: discovery.installationId,
      installedVersion: discovery.helperVersion,
      observation,
    };
  } catch {
    observation.discovery = "missing";
    return { observation };
  }
}

type ToolchainEnvironment = Record<string, string | undefined>;
const developmentTunArgument = "--development-tun";
const tartTunAcceptanceArgument = "--tart-tun-acceptance";
const tartTerminalAuthorizationArgument = "--tart-terminal-authorization";

export type ToolchainDiscovery = {
  cargo: string;
  rustup: string;
};

export type ToolchainDiscoveryOptions = {
  environment?: ToolchainEnvironment;
  homeDirectory?: string;
  execute?: (executable: string, args: string[], environment: ToolchainEnvironment) => string;
  isExecutable?: (candidate: string) => boolean;
};

export function parseDevelopmentServiceArguments(arguments_: string[]) {
  const [requestedAction, ...options] = arguments_;
  const knownOptions = new Set([
    developmentTunArgument,
    tartTunAcceptanceArgument,
    tartTerminalAuthorizationArgument,
  ]);
  const unknown = options.filter((option) => !knownOptions.has(option));
  const developmentTun = options.includes(developmentTunArgument);
  const tartTunAcceptance = options.includes(tartTunAcceptanceArgument);
  const tartTerminalAuthorization = options.includes(tartTerminalAuthorizationArgument);
  if (
    !new Set([
      "install",
      "prepare",
      "repair",
      "reset-key",
      "rotate-key",
      "status",
      "uninstall",
    ]).has(requestedAction ?? "") ||
    unknown.length > 0 ||
    options.some((option, index) => options.indexOf(option) !== index) ||
    (developmentTun && tartTunAcceptance) ||
    (tartTerminalAuthorization &&
      (!tartTunAcceptance ||
        !new Set(["install", "repair", "reset-key", "rotate-key", "uninstall"]).has(
          requestedAction ?? "",
        )))
  ) {
    throw new Error(
      "Usage: node scripts/manage-macos-tun-service.ts <install|prepare|repair|reset-key|rotate-key|status|uninstall> [--development-tun | --tart-tun-acceptance [--tart-terminal-authorization]]",
    );
  }
  return {
    action: requestedAction as
      | "install"
      | "prepare"
      | "repair"
      | "reset-key"
      | "rotate-key"
      | "status"
      | "uninstall",
    developmentTun,
    tartTerminalAuthorization,
    tartTunAcceptance,
  };
}

const invocation = import.meta.main
  ? parseDevelopmentServiceArguments(process.argv.slice(2))
  : ({
      action: "status",
      developmentTun: false,
      tartTerminalAuthorization: false,
      tartTunAcceptance: false,
    } as const);
const action = invocation.action;

export function selectDevelopmentTunLifecycleAction(
  requestedAction: typeof action,
  classification: DevelopmentTunInstallationClassification,
) {
  if (requestedAction === "install" && classification.installation === "recovery-required") {
    throw new InstallerFailure(
      "preparation-failed",
      "install-admission",
      "install-identity-not-admitted",
    );
  }
  if (requestedAction !== "repair") return requestedAction;
  if (
    classification.installation === "recovery-required" ||
    classification.installation === "not-installed"
  ) {
    throw new InstallerFailure(
      "preparation-failed",
      "repair-admission",
      "repair-identity-not-admitted",
    );
  }
  return classification.installation === "repair-required" &&
    classification.reason === "missing-client-key"
    ? ("reset-key" as const)
    : requestedAction;
}

function installerEnvironment(environment: ToolchainEnvironment): ToolchainEnvironment {
  const allowed = ["HOME", "PATH", "CARGO_HOME", "RUSTUP_HOME", "TMPDIR"] as const;
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function executableFile(candidate: string) {
  try {
    return (
      path.isAbsolute(candidate) &&
      statSync(candidate).isFile() &&
      (() => {
        accessSync(candidate, syncConstants.X_OK);
        return true;
      })()
    );
  } catch {
    return false;
  }
}

function rustupCandidates(environment: ToolchainEnvironment, homeDirectory: string) {
  const candidates: Array<{ path: string }> = [];
  const injected = environment.MISH_TUN_RUSTUP;
  if (injected !== undefined) candidates.push({ path: injected });

  const cargoHome = environment.CARGO_HOME;
  if (cargoHome !== undefined && path.isAbsolute(cargoHome)) {
    candidates.push({ path: path.join(cargoHome, "bin", "rustup") });
  }
  candidates.push(
    { path: path.join(homeDirectory, ".cargo", "bin", "rustup") },
    { path: "/opt/homebrew/bin/rustup" },
    { path: "/usr/local/bin/rustup" },
  );
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (path.isAbsolute(directory)) {
      candidates.push({ path: path.join(directory, "rustup") });
    }
  }
  return candidates.filter(
    (candidate, index, all) => all.findIndex((other) => other.path === candidate.path) === index,
  );
}

export function resolveStableCargo(options: ToolchainDiscoveryOptions = {}): ToolchainDiscovery {
  const environment = options.environment ?? process.env;
  const commandEnvironment = installerEnvironment(environment);
  const executable = options.isExecutable ?? executableFile;
  const execute =
    options.execute ??
    ((file, args, env) =>
      execFileSync(file, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }));
  const candidates = rustupCandidates(environment, options.homeDirectory ?? os.homedir());
  const selected = candidates.find((candidate) => executable(candidate.path));
  if (!selected) {
    const injected = environment.MISH_TUN_RUSTUP;
    if (injected !== undefined) {
      throw new InstallerFailure("preparation-failed", "rustup", "rustup-candidate-invalid");
    }
    throw new InstallerFailure("preparation-failed", "rustup", "rustup-unavailable");
  }

  let output: string;
  try {
    output = execute(
      selected.path,
      ["which", "cargo", "--toolchain", "stable"],
      commandEnvironment,
    );
  } catch {
    throw new InstallerFailure("preparation-failed", "cargo", "stable-cargo-unavailable");
  }
  const cargo = output.trim();
  if (!cargo || cargo.includes("\n") || cargo.includes("\r") || !path.isAbsolute(cargo)) {
    throw new InstallerFailure("preparation-failed", "cargo", "stable-cargo-invalid");
  }
  if (!executable(cargo)) {
    throw new InstallerFailure("preparation-failed", "cargo", "stable-cargo-invalid");
  }
  return { cargo, rustup: selected.path };
}

function buildHelper(cargo: string, environment: ToolchainEnvironment = process.env) {
  try {
    const commandEnvironment = installerEnvironment(environment);
    commandEnvironment.PATH = `${path.dirname(cargo)}:${commandEnvironment.PATH ?? ""}`;
    execFileSync(
      cargo,
      [
        "build",
        "-p",
        "mish-platform-macos",
        "--features",
        "development-core-host",
        "--bin",
        "mish-tun-helper",
        "--bin",
        "mish-core-host-ctl",
      ],
      {
        env: commandEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new InstallerFailure("preparation-failed", "helper-build", "cargo-build-failed");
  }
}

const run = (
  executable: string,
  args: string[],
  options: { allowFailure?: boolean; timeoutMilliseconds?: number } = {},
) => {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024,
      stdio: options.allowFailure ? "pipe" : "inherit",
      timeout: options.timeoutMilliseconds,
    });
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
};

function quoteShellArgument(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function authorizedCommand(executable: string, args: string[]) {
  return [executable, ...args].map(quoteShellArgument).join(" ");
}

function runAuthorized(script: string, terminalAuthorization = false) {
  if (terminalAuthorization) {
    try {
      execFileSync("/usr/bin/sudo", ["/bin/sh", "-c", script], {
        env: installerEnvironment(process.env),
        stdio: "inherit",
      });
      return;
    } catch {
      throw new InstallerFailure("installation-failed", "terminal-authorization", "sudo-failed");
    }
  }
  let response: string;
  try {
    response = execFileSync(
      "/usr/bin/osascript",
      [
        "-e",
        "on run argv",
        "-e",
        "try",
        "-e",
        "do shell script (item 1 of argv) with administrator privileges",
        "-e",
        'return "ok"',
        "-e",
        "on error errorMessage number errorNumber",
        "-e",
        'return "error:" & (errorNumber as string)',
        "-e",
        "end try",
        "-e",
        "end run",
        "--",
        script,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new InstallerFailure("installation-failed", "authorization", "osascript-failed");
  }
  if (response === "ok") return;
  if (response === "error:-128") {
    throw new InstallerFailure(
      "authorization-cancelled",
      "authorization",
      "administrator-prompt-cancelled",
    );
  }
  throw new InstallerFailure(
    "installation-failed",
    "privileged-install",
    response.startsWith("error:") ? `macos-${response}` : "unexpected-authorization-result",
  );
}

function tolerantAuthorizedCommand(executable: string, args: string[]) {
  return `${authorizedCommand(executable, args)} >/dev/null 2>&1 || true`;
}

function moveIfPresentAuthorizedCommand(source: string, destination: string) {
  const sourceArgument = quoteShellArgument(source);
  return `if [ -e ${sourceArgument} ] || [ -L ${sourceArgument} ]; then ${authorizedCommand(
    "/bin/mv",
    [source, destination],
  )}; fi`;
}

function removeEnrollmentAuthorizedCommand(uid: number) {
  const helper = quoteShellArgument(helperTarget);
  const removeEnrollment = authorizedCommand("/usr/bin/env", [
    `MISH_TUN_SERVICE_ALLOWED_UID=${uid}`,
    `MISH_TUN_SERVICE_ENROLLMENT_RECORD=${enrollmentTarget}`,
    helperTarget,
    "--remove-enrollment",
  ]);
  const removeEmptyDirectory = tolerantAuthorizedCommand("/bin/rmdir", [enrollmentDirectory]);
  return `if [ -x ${helper} ]; then ${removeEnrollment}; else ${removeEmptyDirectory}; fi`;
}

export function buildDevelopmentServiceUninstallScript(
  uid: number,
  gid: number,
  quarantine: string,
) {
  if (
    !Number.isSafeInteger(uid) ||
    uid < 1 ||
    !Number.isSafeInteger(gid) ||
    gid < 1 ||
    !path.isAbsolute(quarantine)
  ) {
    throw new InstallerFailure("preparation-failed", "uninstall", "invalid-uninstall-identity");
  }
  const socket = `/var/run/com.asuka109.mish.tun-helper.${uid}.sock`;
  const targets = [plistTarget, helperTarget, coreTarget, socket, `${socket}.state`];
  return [
    tolerantAuthorizedCommand("/bin/launchctl", ["bootout", `system/${label}`]),
    removeEnrollmentAuthorizedCommand(uid),
    authorizedCommand("/usr/bin/install", [
      "-d",
      "-o",
      uid.toString(),
      "-g",
      gid.toString(),
      "-m",
      "0700",
      quarantine,
    ]),
    ...targets.map((target) =>
      moveIfPresentAuthorizedCommand(target, path.join(quarantine, path.basename(target))),
    ),
    authorizedCommand("/usr/sbin/chown", ["-R", `${uid}:${gid}`, quarantine]),
  ].join(" &&\n");
}

async function moveInstallerReceiptToTrash(quarantine: string) {
  try {
    await access(installerRoot);
  } catch {
    return;
  }
  await mkdir(path.dirname(quarantine), { recursive: true, mode: 0o700 });
  await rename(installerRoot, path.join(quarantine, "tun-service-installer"));
}

async function writeResult(result: InstallerResult) {
  await mkdir(installerRoot, { recursive: true, mode: 0o700 });
  await chmod(installerRoot, 0o700);
  await writeFile(resultReceipt, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  await chmod(resultReceipt, 0o600);
}

async function report(result: InstallerResult) {
  try {
    await writeResult(result);
  } catch {
    // The stdout result remains authoritative when the bounded receipt cannot be written.
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function printResult(result: InstallerResult) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function validKeyId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

async function writeAtomicPrivateJson(file: string, value: unknown) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}`);
  const bytes = `${JSON.stringify(value)}\n`;
  let handle;
  try {
    const parent = await lstat(path.dirname(file));
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== uid ||
      (parent.mode & 0o077) !== 0
    ) {
      throw new Error("private parent rejected");
    }
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new InstallerFailure(
      "preparation-failed",
      "installation-key",
      "installation-key-persistence-failed",
    );
  }
}

function validateClientKeyRecord(value: unknown): InstallationClientKeyRecord {
  const record = value as Partial<InstallationClientKeyRecord>;
  if (
    typeof value !== "object" ||
    value === null ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        ["algorithm", "keyId", "privateKeyPkcs8", "publicKeySpki", "schemaVersion"].sort(),
      ) ||
    record.schemaVersion !== installationKeyRecordVersion ||
    record.algorithm !== installationKeyAlgorithm ||
    !validKeyId(record.keyId) ||
    typeof record.privateKeyPkcs8 !== "string" ||
    typeof record.publicKeySpki !== "string"
  ) {
    throw new InstallerFailure(
      "preparation-failed",
      "installation-key",
      "installation-key-record-invalid",
    );
  }
  try {
    const privateKey = createPrivateKey({
      format: "der",
      key: Buffer.from(record.privateKeyPkcs8, "base64"),
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    if (
      !publicKey.equals(Buffer.from(record.publicKeySpki, "base64")) ||
      createHash("sha256").update(publicKey).digest("hex") !== record.keyId
    ) {
      throw new Error("key pair mismatch");
    }
  } catch {
    throw new InstallerFailure(
      "preparation-failed",
      "installation-key",
      "installation-key-record-invalid",
    );
  }
  return record as InstallationClientKeyRecord;
}

async function readClientKeyRecord(
  file: string,
  uid: number,
): Promise<InstallationClientKeyRecord> {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new InstallerFailure(
        "preparation-failed",
        "installation-key",
        "installation-key-metadata-invalid",
      );
    }
    throw new InstallerFailure(
      "preparation-failed",
      "installation-key",
      "installation-key-missing",
    );
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > 16 * 1024
  ) {
    throw new InstallerFailure(
      "preparation-failed",
      "installation-key",
      "installation-key-metadata-invalid",
    );
  }
  try {
    return validateClientKeyRecord(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof InstallerFailure) throw error;
    throw new InstallerFailure(
      "preparation-failed",
      "installation-key",
      "installation-key-record-invalid",
    );
  }
}

async function readOptionalClientKeyRecord(file: string, uid: number) {
  try {
    await access(file);
  } catch {
    return undefined;
  }
  return readClientKeyRecord(file, uid);
}

async function readObservedOptionalClientKeyRecord(file: string, uid: number) {
  try {
    return await readClientKeyRecord(file, uid);
  } catch (error) {
    if (error instanceof InstallerFailure && error.code === "installation-key-missing") {
      return undefined;
    }
    throw error;
  }
}

function generateClientKeyRecord(): InstallationClientKeyRecord {
  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { format: "der", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  });
  return {
    algorithm: installationKeyAlgorithm,
    keyId: createHash("sha256").update(pair.publicKey).digest("hex"),
    privateKeyPkcs8: pair.privateKey.toString("base64"),
    publicKeySpki: pair.publicKey.toString("base64"),
    schemaVersion: installationKeyRecordVersion,
  };
}

export async function ensureInstallationClientKey(
  file: string,
  uid: number,
): Promise<InstallationClientKeyRecord> {
  const existing = await readOptionalClientKeyRecord(file, uid);
  if (existing) return existing;
  const generated = generateClientKeyRecord();
  await writeAtomicPrivateJson(file, generated);
  return readClientKeyRecord(file, uid);
}

function publicCandidate(
  key: InstallationClientKeyRecord,
  uid: number,
  installationId: string,
): InstallationPublicKeyCandidate {
  return {
    algorithm: installationKeyAlgorithm,
    helperInstallationId: installationId,
    installingUid: uid,
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
    schemaVersion: installationKeyRecordVersion,
  };
}

function pushU16(parts: Buffer[], value: number) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  parts.push(bytes);
}

function pushU32(parts: Buffer[], value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  parts.push(bytes);
}

function pushU64(parts: Buffer[], value: number) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  parts.push(bytes);
}

function pushString(parts: Buffer[], value: string) {
  const bytes = Buffer.from(value, "utf8");
  pushU32(parts, bytes.length);
  parts.push(bytes);
}

export function canonicalRotationTranscript(request: InstallationKeyRotationRequest) {
  const parts = [Buffer.from("MISH-TUN-INSTALLATION-ROTATION\0", "utf8")];
  pushU16(parts, request.transcriptVersion);
  pushString(parts, request.algorithm);
  pushString(parts, request.helperInstallationId);
  pushU32(parts, request.installingUid);
  pushU64(parts, request.currentGeneration);
  pushString(parts, request.currentKeyId);
  pushU64(parts, request.currentGeneration + 1);
  pushString(parts, request.replacementKeyId);
  parts.push(
    createHash("sha256").update(Buffer.from(request.replacementPublicKeySpki, "base64")).digest(),
  );
  return Buffer.concat(parts);
}

function privateKeyObject(record: InstallationClientKeyRecord) {
  return createPrivateKey({
    format: "der",
    key: Buffer.from(record.privateKeyPkcs8, "base64"),
    type: "pkcs8",
  });
}

export function buildRotationRequest(
  current: InstallationClientKeyRecord,
  replacement: InstallationClientKeyRecord,
  discovery: InstallationDiscovery,
  uid: number,
): InstallationKeyRotationRequest {
  if (
    discovery.algorithm !== installationKeyAlgorithm ||
    discovery.protocolVersion !== tunHelperProtocolVersion ||
    !Number.isSafeInteger(discovery.generation) ||
    discovery.generation < 1 ||
    discovery.keyId !== current.keyId ||
    !validKeyId(discovery.installationId) ||
    current.keyId === replacement.keyId
  ) {
    throw new InstallerFailure(
      "preparation-failed",
      "installation-key-rotation",
      "current-enrollment-mismatch",
    );
  }
  const request: InstallationKeyRotationRequest = {
    algorithm: installationKeyAlgorithm,
    currentGeneration: discovery.generation,
    currentKeyId: current.keyId,
    helperInstallationId: discovery.installationId,
    installingUid: uid,
    newSignature: "",
    oldSignature: "",
    replacementKeyId: replacement.keyId,
    replacementPublicKeySpki: replacement.publicKeySpki,
    schemaVersion: installationKeyRecordVersion,
    transcriptVersion: installationKeyTranscriptVersion,
  };
  const transcript = canonicalRotationTranscript(request);
  request.oldSignature = sign("sha256", transcript, privateKeyObject(current)).toString("base64");
  request.newSignature = sign("sha256", transcript, privateKeyObject(replacement)).toString(
    "base64",
  );
  return request;
}

export function buildInstallationDiscoveryRequest(
  requestId: string,
  protocolVersion = tunHelperProtocolVersion,
) {
  return {
    command: { kind: "health" },
    kind: "discovery",
    protocol_version: protocolVersion,
    request_id: requestId,
  };
}

async function discoverInstallation(
  socketPath: string,
  timeoutMilliseconds = 6_000,
  protocolVersion = tunHelperProtocolVersion,
): Promise<InstallationDiscovery> {
  const requestId = randomUUID();
  const request = Buffer.from(
    JSON.stringify(buildInstallationDiscoveryRequest(requestId, protocolVersion)),
  );
  const frame = Buffer.alloc(request.length + 4);
  frame.writeUInt32BE(request.length);
  request.copy(frame, 4);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let expected: number | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("discovery timed out"));
    }, timeoutMilliseconds);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      expected ??= combined.length >= 4 ? combined.readUInt32BE(0) : undefined;
      if (combined.length > 16 * 1024 + 4 || (expected !== undefined && expected > 16 * 1024)) {
        fail(new Error("discovery response too large"));
        return;
      }
      if (expected === undefined || combined.length < expected + 4) return;
      clearTimeout(timer);
      socket.end();
      try {
        const message = JSON.parse(combined.subarray(4, expected + 4).toString("utf8")) as {
          discovery?: InstallationDiscovery & { requestId?: string };
          kind?: string;
        };
        if (
          message.kind !== "discovery" ||
          message.discovery?.requestId !== requestId ||
          message.discovery.algorithm !== installationKeyAlgorithm ||
          !Number.isSafeInteger(message.discovery.generation) ||
          message.discovery.generation < 1 ||
          !Number.isSafeInteger(message.discovery.protocolVersion) ||
          message.discovery.protocolVersion < 1 ||
          message.discovery.protocolVersion > 65_535 ||
          typeof message.discovery.helperVersion !== "string" ||
          message.discovery.helperVersion.length < 1 ||
          message.discovery.helperVersion.length > 64 ||
          !validKeyId(message.discovery.installationId) ||
          !validKeyId(message.discovery.keyId)
        ) {
          throw new Error("discovery response invalid");
        }
        resolve(message.discovery);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("discovery response invalid"));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("end", () => {
      if (expected === undefined || Buffer.concat(chunks).length < expected + 4) {
        fail(new Error("discovery response incomplete"));
      }
    });
  });
}

async function waitForInstallationDiscovery(
  socketPath: string,
  timeoutMilliseconds = 60_000,
): Promise<InstallationDiscovery> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown = new Error("installation discovery did not start");
  while (Date.now() < deadline) {
    try {
      return await discoverInstallation(
        socketPath,
        Math.max(1, Math.min(6_000, deadline - Date.now())),
      );
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
  }
  throw lastError;
}

type PendingKeyPromotionRecords = {
  activeClientKey: string;
  activeEnrollment: string;
  pendingClientKey: string;
  pendingEnrollment: string;
};

const pendingKeyPromotionRecords: PendingKeyPromotionRecords = {
  activeClientKey: clientKeyPath,
  activeEnrollment: enrollmentCandidatePath,
  pendingClientKey: pendingClientKeyPath,
  pendingEnrollment: pendingEnrollmentCandidatePath,
};

export async function finalizePendingKeyIfEnrolled(
  socketPath: string,
  uid: number,
  knownDiscovery?: InstallationDiscovery,
  records = pendingKeyPromotionRecords,
) {
  const pending = await readOptionalClientKeyRecord(records.pendingClientKey, uid);
  if (!pending) return knownDiscovery;
  let discovery: InstallationDiscovery;
  if (knownDiscovery) {
    discovery = knownDiscovery;
  } else {
    try {
      discovery = await discoverInstallation(socketPath);
    } catch {
      return undefined;
    }
  }
  if (discovery.keyId !== pending.keyId) return discovery;
  let pendingEnrollment: InstallationPublicKeyCandidate;
  try {
    pendingEnrollment = await readEnrollmentCandidate(records.pendingEnrollment, uid);
  } catch {
    throw new InstallerFailure(
      "preparation-failed",
      "installation-key",
      "pending-enrollment-candidate-invalid",
    );
  }
  if (
    pendingEnrollment.installingUid !== uid ||
    pendingEnrollment.keyId !== pending.keyId ||
    pendingEnrollment.publicKeySpki !== pending.publicKeySpki ||
    pendingEnrollment.helperInstallationId !== discovery.installationId
  ) {
    throw new InstallerFailure(
      "preparation-failed",
      "installation-key",
      "pending-enrollment-candidate-mismatch",
    );
  }
  await writeAtomicPrivateJson(records.activeEnrollment, pendingEnrollment);
  await writeAtomicPrivateJson(records.activeClientKey, pending);
  await unlink(records.pendingClientKey);
  await unlink(records.pendingEnrollment);
  return discovery;
}

async function removeIfPresent(file: string) {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function cleanupFailedInstallation(uid: number, gid: number, terminalAuthorization: boolean) {
  const quarantine = path.join(
    os.homedir(),
    ".Trash",
    `Mish Core Host Failed Install ${Date.now()} ${randomUUID()}`,
  );
  runAuthorized(
    buildDevelopmentServiceUninstallScript(uid, gid, quarantine),
    terminalAuthorization,
  );
  await moveInstallerReceiptToTrash(quarantine);
  await removeIfPresent(pendingClientKeyPath);
}

async function prepare(uid: number, allowTun: boolean, lifecycleAction: typeof action) {
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  await mkdir(installerRoot, { recursive: true, mode: 0o700 });
  await chmod(installerRoot, 0o700);
  let release: MacOsMihomoRelease;
  try {
    release = JSON.parse(await readFile(releaseManifestPath, "utf8")) as MacOsMihomoRelease;
  } catch {
    throw new InstallerFailure(
      "preparation-failed",
      "core-manifest",
      "pinned-core-manifest-invalid",
    );
  }
  const sourceCore = path.resolve(
    ".scratch/mihomo",
    release.version,
    release.asset.replace(/\.gz$/u, ""),
  );
  try {
    await access(sourceCore, constants.X_OK);
  } catch {
    throw new InstallerFailure("preparation-failed", "core-artifact", "pinned-core-missing");
  }
  const coreDigest = createHash("sha256")
    .update(await readFile(sourceCore))
    .digest("hex");
  if (
    release.schemaVersion !== 1 ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(release.version) ||
    !/^[a-f0-9]{64}$/u.test(release.binarySha256) ||
    coreDigest !== release.binarySha256
  ) {
    throw new InstallerFailure(
      "preparation-failed",
      "core-artifact",
      "pinned-core-digest-mismatch",
    );
  }
  let reportedVersion: string;
  try {
    reportedVersion = execFileSync(sourceCore, ["-v"], {
      encoding: "utf8",
      env: installerEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
  } catch {
    throw new InstallerFailure(
      "preparation-failed",
      "core-artifact",
      "pinned-core-version-unavailable",
    );
  }
  if (!reportedVersion.split(/\s+/u).includes(release.version)) {
    throw new InstallerFailure(
      "preparation-failed",
      "core-artifact",
      "pinned-core-version-mismatch",
    );
  }

  const { cargo } = resolveStableCargo();
  buildHelper(cargo);

  const helperSource = path.resolve("target/debug/mish-tun-helper");
  const escapeXml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const installationIdPlaceholder = "MISH_TUN_SERVICE_INSTALLATION_ID_PLACEHOLDER";
  const socket = `/var/run/com.asuka109.mish.tun-helper.${uid}.sock`;
  const plistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${helperTarget}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MISH_TUN_SERVICE_ALLOWED_UID</key><string>${uid}</string>
    <key>MISH_TUN_SERVICE_ALLOW_TUN</key><string>${allowTun ? "1" : "0"}</string>
    <key>MISH_TUN_SERVICE_CORE_BINARY</key><string>${coreTarget}</string>
    <key>MISH_TUN_SERVICE_ENROLLMENT_RECORD</key><string>${escapeXml(enrollmentTarget)}</string>
    <key>MISH_TUN_SERVICE_INSTALLATION_ID</key><string>${installationIdPlaceholder}</string>
    <key>MISH_TUN_SERVICE_RUNTIME_ROOT</key><string>${escapeXml(runtimeRoot)}</string>
    <key>MISH_TUN_SERVICE_SOCKET</key><string>${socket}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
  let installationId: string;
  try {
    installationId = createHash("sha256")
      .update(await readFile(helperSource))
      .update(await readFile(sourceCore))
      .update(plistTemplate)
      .digest("hex");
    await writeFile(plist, plistTemplate.replace(installationIdPlaceholder, installationId), {
      mode: 0o600,
    });
    await chmod(plist, 0o600);
  } catch {
    throw new InstallerFailure("preparation-failed", "installer-receipt", "receipt-write-failed");
  }
  const activeKey =
    lifecycleAction === "reset-key"
      ? await readOptionalClientKeyRecord(clientKeyPath, uid)
      : await ensureInstallationClientKey(clientKeyPath, uid);
  let pendingKey = await readOptionalClientKeyRecord(pendingClientKeyPath, uid);
  if (lifecycleAction === "rotate-key" || lifecycleAction === "reset-key") {
    if (!pendingKey) {
      pendingKey = generateClientKeyRecord();
      await writeAtomicPrivateJson(pendingClientKeyPath, pendingKey);
      pendingKey = await readClientKeyRecord(pendingClientKeyPath, uid);
    }
    if (activeKey?.keyId === pendingKey.keyId) {
      throw new InstallerFailure(
        "preparation-failed",
        "installation-key",
        "replacement-key-must-be-new",
      );
    }
  }
  if (activeKey) {
    await writeAtomicPrivateJson(
      enrollmentCandidatePath,
      publicCandidate(activeKey, uid, installationId),
    );
  }
  if (pendingKey) {
    await writeAtomicPrivateJson(
      pendingEnrollmentCandidatePath,
      publicCandidate(pendingKey, uid, installationId),
    );
  }
  if (lifecycleAction === "rotate-key") {
    if (!activeKey || !pendingKey) {
      throw new InstallerFailure(
        "preparation-failed",
        "installation-key-rotation",
        "rotation-key-unavailable",
      );
    }
    let discovery: InstallationDiscovery;
    try {
      discovery = await discoverInstallation(socket);
    } catch {
      throw new InstallerFailure(
        "preparation-failed",
        "installation-key-rotation",
        "current-enrollment-unavailable",
      );
    }
    await writeAtomicPrivateJson(
      rotationRequestPath,
      buildRotationRequest(activeKey, pendingKey, { ...discovery, installationId }, uid),
    );
  }
  return {
    activeEnrollment: activeKey ? enrollmentCandidatePath : undefined,
    helperSource,
    installationId,
    pendingEnrollment: pendingKey ? pendingEnrollmentCandidatePath : undefined,
    rotationRequest: lifecycleAction === "rotate-key" ? rotationRequestPath : undefined,
    socket,
    sourceCore,
  };
}

async function main() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    uid === undefined ||
    gid === undefined
  ) {
    throw new InstallerFailure("preparation-failed", "platform", "unsupported-development-host");
  }

  if (action === "status") {
    const status = run("/bin/launchctl", ["print", `system/${label}`], {
      allowFailure: true,
      timeoutMilliseconds: 1_500,
    });
    const observed = await observeDevelopmentTunInstallation(uid, status.length > 0);
    const classified = classifyDevelopmentTunInstallation(observed.observation);
    printResult({
      installation: classified.installation,
      installationId: classified.installation === "installed" ? observed.installationId : undefined,
      installedVersion:
        classified.installation === "installed" ? observed.installedVersion : undefined,
      ok: true,
      reason: classified.reason,
      service: classified.installation === "not-installed" ? "not-installed" : "installed",
      stage: "status",
    });
    return;
  }

  if (action === "uninstall") {
    const quarantine = path.join(
      os.homedir(),
      ".Trash",
      `Mish Core Host Uninstall ${Date.now()} ${randomUUID()}`,
    );
    runAuthorized(
      buildDevelopmentServiceUninstallScript(uid, gid, quarantine),
      invocation.tartTerminalAuthorization,
    );
    try {
      await moveInstallerReceiptToTrash(quarantine);
      await removeIfPresent(clientKeyPath);
      await removeIfPresent(pendingClientKeyPath);
    } catch {
      throw new InstallerFailure(
        "installation-failed",
        "uninstall-receipt",
        "receipt-trash-failed",
      );
    }
    printResult({ ok: true, service: "not-installed", stage: "completed" });
    return;
  }

  const developmentSocket = `/var/run/com.asuka109.mish.tun-helper.${uid}.sock`;
  let lifecycleAction = action;
  if (action === "repair" || action === "install") {
    const serviceStatus = run("/bin/launchctl", ["print", `system/${label}`], {
      allowFailure: true,
      timeoutMilliseconds: 1_500,
    });
    const observed = await observeDevelopmentTunInstallation(uid, serviceStatus.length > 0);
    lifecycleAction = selectDevelopmentTunLifecycleAction(
      action,
      classifyDevelopmentTunInstallation(observed.observation),
    );
  }
  await finalizePendingKeyIfEnrolled(developmentSocket, uid);
  const prepared = await prepare(
    uid,
    invocation.developmentTun || invocation.tartTunAcceptance,
    lifecycleAction,
  );
  if (action === "prepare") {
    await report({ ok: true, stage: "prepared" });
    return;
  }

  const enrollmentEnvironment = [
    `MISH_TUN_SERVICE_ALLOWED_UID=${uid}`,
    `MISH_TUN_SERVICE_INSTALLATION_ID=${prepared.installationId}`,
    `MISH_TUN_SERVICE_ENROLLMENT_RECORD=${enrollmentTarget}`,
  ];
  const enrollmentCommands =
    lifecycleAction === "reset-key"
      ? [
          authorizedCommand("/usr/bin/env", [
            ...enrollmentEnvironment,
            helperTarget,
            "--reset",
            prepared.pendingEnrollment!,
          ]),
        ]
      : [
          authorizedCommand("/usr/bin/env", [
            ...enrollmentEnvironment,
            helperTarget,
            "--enroll",
            prepared.activeEnrollment!,
            ...(prepared.pendingEnrollment ? [prepared.pendingEnrollment] : []),
          ]),
          ...(lifecycleAction === "rotate-key"
            ? [
                authorizedCommand("/usr/bin/env", [
                  ...enrollmentEnvironment,
                  helperTarget,
                  "--rotate",
                  prepared.rotationRequest!,
                ]),
              ]
            : []),
        ];
  const installCommands = [
    tolerantAuthorizedCommand("/bin/launchctl", ["bootout", `system/${label}`]),
    authorizedCommand("/usr/bin/install", [
      "-d",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0755",
      helperDirectory,
    ]),
    authorizedCommand("/usr/bin/install", [
      "-d",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0700",
      enrollmentDirectory,
    ]),
    authorizedCommand("/usr/bin/install", [
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0555",
      prepared.helperSource,
      helperTarget,
    ]),
    authorizedCommand("/usr/bin/install", [
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0555",
      prepared.sourceCore,
      coreTarget,
    ]),
    authorizedCommand("/usr/bin/install", [
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0644",
      plist,
      plistTarget,
    ]),
    ...enrollmentCommands,
    authorizedCommand("/bin/launchctl", ["bootstrap", "system", plistTarget]),
    authorizedCommand("/bin/launchctl", ["kickstart", `system/${label}`]),
  ];
  let discovery: InstallationDiscovery;
  try {
    runAuthorized(installCommands.join(" &&\n"), invocation.tartTerminalAuthorization);
    try {
      discovery = await waitForInstallationDiscovery(prepared.socket);
    } catch {
      throw new InstallerFailure(
        "installation-failed",
        "installation-health",
        "installed-enrollment-unavailable",
      );
    }
    if (
      discovery.installationId !== prepared.installationId ||
      discovery.algorithm !== installationKeyAlgorithm ||
      discovery.protocolVersion !== tunHelperProtocolVersion
    ) {
      throw new InstallerFailure(
        "installation-failed",
        "installation-health",
        "installed-enrollment-mismatch",
      );
    }
  } catch (error) {
    if (error instanceof InstallerFailure && error.kind === "authorization-cancelled") {
      throw error;
    }
    try {
      await cleanupFailedInstallation(uid, gid, invocation.tartTerminalAuthorization);
    } catch {
      throw new InstallerFailure(
        "installation-failed",
        "failure-cleanup",
        "failed-installation-cleanup-unconfirmed",
      );
    }
    throw error;
  }
  await finalizePendingKeyIfEnrolled(prepared.socket, uid, discovery);
  await report({
    generation: discovery.generation,
    installationId: discovery.installationId,
    keyId: discovery.keyId,
    ok: true,
    operation: action,
    stage: "completed",
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof InstallerFailure) {
      await report({
        code: error.code,
        kind: error.kind,
        ok: false,
        stage: error.stage,
      });
    } else {
      await report({
        code: "unexpected-installer-failure",
        kind: "preparation-failed",
        ok: false,
        stage: "installer",
      });
    }
    process.exitCode = 1;
  }
}
