import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const transcriptSchemaVersion = 1 as const;
export const transcriptCapturePolicy = "read-only-system-proxy-v1" as const;
export const rawTranscriptFileName = "raw-transcript.json";
export const sensitiveMarkerFileName = "SENSITIVE-RAW-PLATFORM-EVIDENCE";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const rawRoot = path.join(repositoryRoot, ".scratch/macos-platform-transcripts/raw");
const fixtureRoot = path.join(repositoryRoot, "docs/quality/fixtures/macos-platform-transcripts");
const commandTimeoutMilliseconds = 5_000;
const commandMaximumBytes = 65_536;
const rawTranscriptMaximumBytes = 1_048_576;
const sanitizedOutputMaximumBytes = 8_192;
const quarantineName = /^mish-329-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const fixtureName = /^system-proxy-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u;
const privacyDiffName = /^system-proxy-[a-z0-9]+(?:-[a-z0-9]+)*\.privacy\.md$/u;

export type RawResultKind =
  | "failed"
  | "output-too-large"
  | "permission-denied"
  | "success"
  | "timed-out"
  | "unavailable";

export type RequestKind =
  | "default-route"
  | "get-auto-proxy-url"
  | "get-http-proxy"
  | "get-https-proxy"
  | "get-proxy-auto-discovery"
  | "get-proxy-bypass-domains"
  | "get-socks-proxy"
  | "list-network-service-order"
  | "macos-architecture"
  | "macos-build-version"
  | "macos-product-version";

export type RawRecord = {
  arguments: string[];
  program: string;
  requestKind: RequestKind;
  result: { kind: Exclude<RawResultKind, "success"> } | { kind: "success"; stdout: string };
};

export type RawTranscript = {
  capturePolicy: typeof transcriptCapturePolicy;
  locale: "C";
  records: RawRecord[];
  schemaVersion: typeof transcriptSchemaVersion;
  sensitive: true;
};

type SanitizedRequestKind = Exclude<
  RequestKind,
  "macos-architecture" | "macos-build-version" | "macos-product-version"
>;

export type SanitizedTranscript = {
  architecture: "arm64" | "x86_64";
  buildFamily: string;
  fixtureKind: "macos-command-runner-system-proxy";
  locale: "C";
  platformFamily: "macos";
  productVersionFamily: string;
  provenance: {
    captureEnvironment: "disposable-tart-clone" | "repository-synthetic";
    capturePolicy: typeof transcriptCapturePolicy;
    compiler: "macos-platform-transcript-v1";
    fixtureId: string;
    sanitizedTranscriptSha256: string;
    sourceKind: "real-tart-capture" | "synthetic-test";
  };
  requests: Array<{
    operand: null | { networkService: string };
    requestKind: SanitizedRequestKind;
    result: { kind: Exclude<RawResultKind, "success"> } | { kind: "success"; stdout: string };
    tool: "networksetup" | "route";
  }>;
  schemaVersion: typeof transcriptSchemaVersion;
  toolEvidence: Array<{
    identity: "networksetup" | "route";
    pathClass: "macos-system-networksetup" | "macos-system-route";
    versionEvidence: "not-observable";
  }>;
};

export type CompileOptions = {
  fixtureId: string;
  sourceKind: SanitizedTranscript["provenance"]["sourceKind"];
};

type CommandDefinition = {
  arguments: string[];
  program: string;
  requestKind: RequestKind;
};

type CommandExecution = {
  exitCode: number | null;
  spawnError?: NodeJS.ErrnoException;
  stderr: Buffer;
  stdout: Buffer;
  timedOut: boolean;
};

type Cleanup = (root: string) => Promise<void>;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} contains missing or unexpected fields.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= maximum;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function strictLines(output: string): string[] {
  invariant(!output.includes("\0"), "Platform output contains a NUL byte.");
  invariant(
    !/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/u.test(output) &&
      !/(?:^|\n)\s*(?:password|secret|token|proxy-authorization)\s*[:=]/iu.test(output) &&
      !/(?:^|\n)\s*(?:proxies|proxy-providers|rules|payload)\s*:/iu.test(output),
    "Raw output matched a forbidden secret, credential, or configuration shape.",
  );
  const lines = output.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  invariant(lines.length <= 256, "Platform output contains too many lines.");
  invariant(
    lines.every(
      (line) =>
        Buffer.byteLength(line) <= 1_024 &&
        !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(line),
    ),
    "Platform output contains an oversized line or control character.",
  );
  return lines;
}

function keyValueLines(output: string, allowedKeys: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of strictLines(output)) {
    const separator = line.indexOf(":");
    invariant(separator > 0, "Platform output contains a malformed field.");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    invariant(allowedKeys.includes(key), `Platform output contains unexpected field: ${key}.`);
    invariant(!values.has(key), `Platform output repeats field: ${key}.`);
    values.set(key, value);
  }
  return values;
}

function requiredValue(values: Map<string, string>, key: string): string {
  invariant(values.has(key), `Platform output is missing field: ${key}.`);
  return values.get(key)!;
}

function parseBoolean(value: string, label: string): boolean {
  if (value === "Yes" || value === "On") return true;
  if (value === "No" || value === "Off") return false;
  throw new Error(`${label} has an unsupported boolean spelling.`);
}

function pseudonym(
  index: number,
  kind: "domain" | "hardware-port" | "host" | "interface" | "port" | "service",
): string {
  switch (kind) {
    case "domain":
      return `domain-${index}.fixture.invalid`;
    case "hardware-port":
      return `hardware-port-${index}`;
    case "host":
      return `proxy-host-${index}.fixture.invalid`;
    case "interface":
      return `interface-${index}`;
    case "port":
      return String(40_000 + index);
    case "service":
      return `network-service-${index}`;
  }
}

class Pseudonyms {
  readonly #values = new Map<string, Map<string, string>>();

  map(
    kind: "domain" | "hardware-port" | "host" | "interface" | "port" | "service",
    value: string,
  ): string {
    let values = this.#values.get(kind);
    if (!values) {
      values = new Map();
      this.#values.set(kind, values);
    }
    const existing = values.get(value);
    if (existing) return existing;
    const mapped = pseudonym(values.size + 1, kind);
    values.set(value, mapped);
    return mapped;
  }

  counts(): Record<string, number> {
    return Object.fromEntries(
      ["service", "interface", "hardware-port", "host", "port", "domain"].map((kind) => [
        kind,
        this.#values.get(kind)?.size ?? 0,
      ]),
    );
  }
}

function parseRoute(output: string): { interfaceName: string; sanitized: string } {
  const allowed = [
    "route to",
    "destination",
    "mask",
    "gateway",
    "interface",
    "flags",
    "recvpipe",
    "sendpipe",
    "ssthresh",
    "rtt,msec",
    "rttvar",
    "hopcount",
    "mtu",
    "expire",
  ];
  const values = new Map<string, string>();
  for (const line of strictLines(output)) {
    const trimmed = line.trim();
    if (
      trimmed ===
        "recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire" ||
      /^\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+$/u.test(trimmed)
    ) {
      continue;
    }
    const separator = line.indexOf(":");
    invariant(separator > 0, "Route output contains a malformed field.");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    invariant(allowed.includes(key), `Route output contains unexpected field: ${key}.`);
    invariant(!values.has(key), `Route output repeats field: ${key}.`);
    values.set(key, value);
  }
  const interfaceName = requiredValue(values, "interface");
  invariant(/^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(interfaceName), "Route interface is malformed.");
  return { interfaceName, sanitized: "" };
}

function parseServiceOrder(
  output: string,
  interfaceName: string,
): { hardwarePort: string; service: string } {
  const lines = strictLines(output);
  const deviceSuffix = `Device: ${interfaceName})`;
  const deviceIndex = lines.findIndex((line) => line.trim().endsWith(deviceSuffix));
  invariant(deviceIndex > 0, "Active route interface has no network service mapping.");
  const detail = lines[deviceIndex]!.trim();
  const detailMatch =
    /^\(Hardware Port: (?<hardwarePort>[^,]{1,128}), Device: [A-Za-z][A-Za-z0-9]{0,31}\)$/u.exec(
      detail,
    );
  invariant(detailMatch?.groups?.hardwarePort, "Network service metadata is malformed.");
  const serviceMatch = /^\((?:\d+|\*)\)\s+(?<service>[^\r\n]{1,128})$/u.exec(
    lines[deviceIndex - 1]!.trim(),
  );
  invariant(serviceMatch?.groups?.service, "Network service name is malformed.");
  return {
    hardwarePort: detailMatch.groups.hardwarePort,
    service: serviceMatch.groups.service,
  };
}

function sanitizeManualProxy(output: string, pseudonyms: Pseudonyms): string {
  const values = keyValueLines(output, [
    "Authenticated Proxy Enabled",
    "Enabled",
    "Port",
    "Server",
  ]);
  const enabled = parseBoolean(requiredValue(values, "Enabled"), "Proxy Enabled");
  const authenticated = requiredValue(values, "Authenticated Proxy Enabled");
  invariant(
    authenticated === "0" || authenticated === "1",
    "Proxy authentication flag is malformed.",
  );
  const portText = requiredValue(values, "Port");
  invariant(/^\d{1,5}$/u.test(portText) && Number(portText) <= 65_535, "Proxy port is malformed.");
  const server = requiredValue(values, "Server");
  invariant(server.length <= 253, "Proxy server is oversized.");
  const sanitizedServer = server ? pseudonyms.map("host", server) : "";
  const sanitizedPort = portText === "0" ? "0" : pseudonyms.map("port", portText);
  return [
    `Enabled: ${enabled ? "Yes" : "No"}`,
    `Server: ${sanitizedServer}`,
    `Port: ${sanitizedPort}`,
    `Authenticated Proxy Enabled: ${authenticated}`,
    "",
  ].join("\n");
}

function sanitizePac(output: string, pseudonyms: Pseudonyms): string {
  const values = keyValueLines(output, ["Enabled", "URL"]);
  const enabled = parseBoolean(requiredValue(values, "Enabled"), "Automatic Proxy Enabled");
  const url = requiredValue(values, "URL");
  let sanitizedUrl = "(null)";
  if (url !== "(null)" && url !== "") {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Automatic proxy URL is malformed.");
    }
    invariant(
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash,
      "Automatic proxy URL contains forbidden credentials or components.",
    );
    sanitizedUrl = `${parsed.protocol}//${pseudonyms.map("host", parsed.hostname)}/proxy.pac`;
  }
  return `URL: ${sanitizedUrl}\nEnabled: ${enabled ? "Yes" : "No"}\n`;
}

function sanitizeBypass(output: string, pseudonyms: Pseudonyms): string {
  const lines = strictLines(output)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines.length === 0 ||
    (lines.length === 1 && lines[0]!.startsWith("There aren't any bypass domains set on "))
  ) {
    return "There aren't any bypass domains set on network-service-1.\n";
  }
  invariant(lines.length <= 64, "Proxy bypass list is oversized.");
  return `${lines
    .map((domain) => {
      invariant(domain.length <= 253 && !domain.includes(":"), "Proxy bypass domain is malformed.");
      const wildcard = domain.startsWith("*.") ? "*." : "";
      const normalized = wildcard ? domain.slice(2) : domain;
      invariant(normalized.length > 0, "Proxy bypass domain is malformed.");
      return `${wildcard}${pseudonyms.map("domain", normalized)}`;
    })
    .join("\n")}\n`;
}

function sanitizeDiscovery(output: string): string {
  const values = keyValueLines(output, ["Auto Proxy Discovery"]);
  return `Auto Proxy Discovery: ${parseBoolean(requiredValue(values, "Auto Proxy Discovery"), "Auto Proxy Discovery") ? "On" : "Off"}\n`;
}

const fixedDiscoveryCommands: readonly CommandDefinition[] = [
  {
    arguments: ["-productVersion"],
    program: "/usr/bin/sw_vers",
    requestKind: "macos-product-version",
  },
  { arguments: ["-buildVersion"], program: "/usr/bin/sw_vers", requestKind: "macos-build-version" },
  { arguments: ["-m"], program: "/usr/bin/uname", requestKind: "macos-architecture" },
  { arguments: ["-n", "get", "default"], program: "/sbin/route", requestKind: "default-route" },
  {
    arguments: ["-listnetworkserviceorder"],
    program: "/usr/sbin/networksetup",
    requestKind: "list-network-service-order",
  },
] as const;

function serviceCommands(service: string): readonly CommandDefinition[] {
  return [
    {
      arguments: ["-getwebproxy", service],
      program: "/usr/sbin/networksetup",
      requestKind: "get-http-proxy",
    },
    {
      arguments: ["-getsecurewebproxy", service],
      program: "/usr/sbin/networksetup",
      requestKind: "get-https-proxy",
    },
    {
      arguments: ["-getsocksfirewallproxy", service],
      program: "/usr/sbin/networksetup",
      requestKind: "get-socks-proxy",
    },
    {
      arguments: ["-getautoproxyurl", service],
      program: "/usr/sbin/networksetup",
      requestKind: "get-auto-proxy-url",
    },
    {
      arguments: ["-getproxybypassdomains", service],
      program: "/usr/sbin/networksetup",
      requestKind: "get-proxy-bypass-domains",
    },
    {
      arguments: ["-getproxyautodiscovery", service],
      program: "/usr/sbin/networksetup",
      requestKind: "get-proxy-auto-discovery",
    },
  ] as const;
}

async function executeCommand(definition: CommandDefinition): Promise<CommandExecution> {
  return await new Promise((resolve) => {
    const child = spawn(definition.program, definition.arguments, {
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let oversized = false;
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    const collect = (chunks: Buffer[], chunk: Buffer, isStdout: boolean) => {
      if (isStdout) stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > commandMaximumBytes || stderrBytes > commandMaximumBytes) {
        oversized = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, false));
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, commandTimeoutMilliseconds);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: oversized ? null : exitCode,
        spawnError: oversized
          ? Object.assign(new Error("oversized"), { code: "EFBIG" })
          : spawnError,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
        timedOut,
      });
    });
  });
}

function classifyExecution(execution: CommandExecution): RawRecord["result"] {
  if (execution.timedOut) return { kind: "timed-out" };
  if (execution.spawnError?.code === "ENOENT") return { kind: "unavailable" };
  if (execution.spawnError?.code === "EFBIG") return { kind: "output-too-large" };
  if (execution.spawnError || execution.exitCode !== 0) {
    const stderr = execution.stderr.toString("utf8").toLowerCase();
    return {
      kind:
        stderr.includes("permission") ||
        stderr.includes("must be root") ||
        stderr.includes("not authorized")
          ? "permission-denied"
          : "failed",
    };
  }
  invariant(
    execution.stderr.length === 0,
    "A successful read-only command wrote unexpected stderr.",
  );
  invariant(execution.stdout.length <= commandMaximumBytes, "Command output exceeded its bound.");
  const stdout = execution.stdout.toString("utf8");
  invariant(Buffer.from(stdout).equals(execution.stdout), "Command output is not valid UTF-8.");
  return { kind: "success", stdout };
}

async function recordCommand(definition: CommandDefinition): Promise<RawRecord> {
  return {
    arguments: [...definition.arguments],
    program: definition.program,
    requestKind: definition.requestKind,
    result: classifyExecution(await executeCommand(definition)),
  };
}

async function validateNewQuarantineRoot(outputRoot: string): Promise<string> {
  const resolved = path.resolve(outputRoot);
  invariant(
    path.dirname(resolved) === rawRoot,
    "Raw output must be one direct child of the ignored quarantine root.",
  );
  invariant(
    quarantineName.test(path.basename(resolved)),
    "Raw output directory needs a unique mish-329-* name.",
  );
  await mkdir(rawRoot, { recursive: true, mode: 0o700 });
  invariant((await realpath(rawRoot)) === rawRoot, "Raw quarantine root must not be a symlink.");
  const parentMetadata = await lstat(rawRoot);
  invariant(
    (parentMetadata.mode & 0o077) === 0 &&
      (process.getuid === undefined || parentMetadata.uid === process.getuid()),
    "Raw quarantine root must be private and owned by the invoking user.",
  );
  try {
    await lstat(resolved);
    throw new Error("Raw output directory already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(resolved, { mode: 0o700 });
  return resolved;
}

async function validateExistingQuarantineRoot(inputRoot: string): Promise<string> {
  const resolved = path.resolve(inputRoot);
  invariant(
    path.dirname(resolved) === rawRoot,
    "Raw input must be one direct child of the ignored quarantine root.",
  );
  invariant(
    quarantineName.test(path.basename(resolved)),
    "Raw input directory name is not allowlisted.",
  );
  const metadata = await lstat(resolved);
  invariant(
    metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      (process.getuid === undefined || metadata.uid === process.getuid()),
    "Raw input must be a real directory.",
  );
  invariant((metadata.mode & 0o077) === 0, "Raw input permissions are not private.");
  invariant(
    (await realpath(resolved)) === resolved,
    "Raw input directory must not resolve through a symlink.",
  );
  return resolved;
}

export async function recordTranscript(outputRoot: string): Promise<void> {
  invariant(process.platform === "darwin", "Real transcript capture requires macOS.");
  const root = await validateNewQuarantineRoot(outputRoot);
  try {
    await writeFile(
      path.join(root, sensitiveMarkerFileName),
      "Sensitive raw macOS platform evidence. Do not copy, log, attach, or commit.\n",
      { flag: "wx", mode: 0o600 },
    );
    const records: RawRecord[] = [];
    for (const definition of fixedDiscoveryCommands) records.push(await recordCommand(definition));
    for (const record of records) {
      invariant(
        record.result.kind === "success",
        `Discovery command failed with ${record.result.kind}.`,
      );
    }
    const route = parseRoute((records[3]!.result as { kind: "success"; stdout: string }).stdout);
    const service = parseServiceOrder(
      (records[4]!.result as { kind: "success"; stdout: string }).stdout,
      route.interfaceName,
    ).service;
    invariant(!service.startsWith("-"), "Active network service cannot be used as an option.");
    for (const definition of serviceCommands(service))
      records.push(await recordCommand(definition));
    const transcript: RawTranscript = {
      capturePolicy: transcriptCapturePolicy,
      locale: "C",
      records,
      schemaVersion: transcriptSchemaVersion,
      sensitive: true,
    };
    const content = normalizedJson(transcript);
    invariant(
      Buffer.byteLength(content) <= rawTranscriptMaximumBytes,
      "Raw transcript exceeds its total size bound.",
    );
    await writeFile(path.join(root, rawTranscriptFileName), content, { flag: "wx", mode: 0o600 });
    await chmod(root, 0o700);
  } catch (error) {
    try {
      await cleanupQuarantine(root);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Capture failed and its sensitive quarantine cleanup also failed.",
      );
    }
    throw error;
  }
}

function parseRawTranscript(value: unknown): RawTranscript {
  invariant(isRecord(value), "Raw transcript is not an object.");
  assertExactKeys(
    value,
    ["capturePolicy", "locale", "records", "schemaVersion", "sensitive"],
    "Raw transcript",
  );
  invariant(
    value.schemaVersion === transcriptSchemaVersion,
    "Raw transcript schema version is unsupported.",
  );
  invariant(
    value.capturePolicy === transcriptCapturePolicy,
    "Raw transcript capture policy is unsupported.",
  );
  invariant(
    value.sensitive === true && value.locale === "C",
    "Raw transcript safety metadata is invalid.",
  );
  invariant(
    Array.isArray(value.records) && value.records.length === 11,
    "Raw transcript command count is invalid.",
  );
  const requestKinds = new Set<RequestKind>([
    "default-route",
    "get-auto-proxy-url",
    "get-http-proxy",
    "get-https-proxy",
    "get-proxy-auto-discovery",
    "get-proxy-bypass-domains",
    "get-socks-proxy",
    "list-network-service-order",
    "macos-architecture",
    "macos-build-version",
    "macos-product-version",
  ]);
  const resultKinds = new Set<RawResultKind>([
    "failed",
    "output-too-large",
    "permission-denied",
    "success",
    "timed-out",
    "unavailable",
  ]);
  const records = value.records.map((candidate, index): RawRecord => {
    invariant(isRecord(candidate), `Raw record ${index} is not an object.`);
    assertExactKeys(
      candidate,
      ["arguments", "program", "requestKind", "result"],
      `Raw record ${index}`,
    );
    invariant(
      requestKinds.has(candidate.requestKind as RequestKind),
      `Raw record ${index} has an open request kind.`,
    );
    invariant(
      Array.isArray(candidate.arguments) &&
        candidate.arguments.every((argument) => isBoundedString(argument, 256)),
      `Raw record ${index} has invalid arguments.`,
    );
    invariant(
      isBoundedString(candidate.program, 64),
      `Raw record ${index} has an invalid program.`,
    );
    invariant(isRecord(candidate.result), `Raw record ${index} result is not an object.`);
    invariant(
      resultKinds.has(candidate.result.kind as RawResultKind),
      `Raw record ${index} has an open result kind.`,
    );
    if (candidate.result.kind === "success") {
      assertExactKeys(candidate.result, ["kind", "stdout"], `Raw record ${index} result`);
      invariant(
        isBoundedString(candidate.result.stdout, commandMaximumBytes),
        `Raw record ${index} output is oversized.`,
      );
    } else {
      assertExactKeys(candidate.result, ["kind"], `Raw record ${index} result`);
    }
    return candidate as RawRecord;
  });
  return { ...value, records } as RawTranscript;
}

function expectedDefinition(kind: RequestKind, service?: string): CommandDefinition {
  const definitions = [
    ...fixedDiscoveryCommands,
    ...(service === undefined ? [] : serviceCommands(service)),
  ];
  const definition = definitions.find((candidate) => candidate.requestKind === kind);
  invariant(definition, `Request kind ${kind} is not part of the fixed capture policy.`);
  return definition;
}

function validateRecordIdentity(record: RawRecord, expected: CommandDefinition): void {
  invariant(
    record.program === expected.program &&
      JSON.stringify(record.arguments) === JSON.stringify(expected.arguments),
    `Request ${record.requestKind} changed its allowlisted program or arguments.`,
  );
}

function successfulOutput(record: RawRecord): string {
  invariant(
    record.result.kind === "success",
    `${record.requestKind} must succeed before its output can select operands.`,
  );
  return record.result.stdout;
}

function normalizedError(record: RawRecord): Exclude<RawRecord["result"], { kind: "success" }> {
  invariant(record.result.kind !== "success", "Expected a typed command error.");
  return { kind: record.result.kind };
}

export function validateSanitizedTranscript(value: unknown): asserts value is SanitizedTranscript {
  invariant(isRecord(value), "Sanitized fixture is not an object.");
  assertExactKeys(
    value,
    [
      "architecture",
      "buildFamily",
      "fixtureKind",
      "locale",
      "platformFamily",
      "productVersionFamily",
      "provenance",
      "requests",
      "schemaVersion",
      "toolEvidence",
    ],
    "Sanitized fixture",
  );
  invariant(value.schemaVersion === 1, "Sanitized fixture schema version is unsupported.");
  invariant(
    value.fixtureKind === "macos-command-runner-system-proxy" &&
      value.platformFamily === "macos" &&
      value.locale === "C",
    "Sanitized fixture identity is invalid.",
  );
  invariant(
    value.architecture === "arm64" || value.architecture === "x86_64",
    "Sanitized fixture architecture is invalid.",
  );
  invariant(
    /^\d{2}\.x$/u.test(String(value.productVersionFamily)),
    "Product version family is invalid.",
  );
  invariant(/^\d{2}[A-Z]$/u.test(String(value.buildFamily)), "Build family is invalid.");

  invariant(isRecord(value.provenance), "Sanitized fixture provenance is invalid.");
  assertExactKeys(
    value.provenance,
    [
      "captureEnvironment",
      "capturePolicy",
      "compiler",
      "fixtureId",
      "sanitizedTranscriptSha256",
      "sourceKind",
    ],
    "Sanitized fixture provenance",
  );
  invariant(
    value.provenance.capturePolicy === transcriptCapturePolicy &&
      value.provenance.compiler === "macos-platform-transcript-v1" &&
      typeof value.provenance.fixtureId === "string" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.provenance.fixtureId) &&
      typeof value.provenance.sanitizedTranscriptSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(value.provenance.sanitizedTranscriptSha256),
    "Sanitized fixture provenance values are invalid.",
  );
  invariant(
    (value.provenance.sourceKind === "real-tart-capture" &&
      value.provenance.captureEnvironment === "disposable-tart-clone") ||
      (value.provenance.sourceKind === "synthetic-test" &&
        value.provenance.captureEnvironment === "repository-synthetic"),
    "Sanitized fixture source provenance is inconsistent.",
  );

  const expected = [
    ["default-route", "route", false],
    ["list-network-service-order", "networksetup", false],
    ["get-http-proxy", "networksetup", true],
    ["get-https-proxy", "networksetup", true],
    ["get-socks-proxy", "networksetup", true],
    ["get-auto-proxy-url", "networksetup", true],
    ["get-proxy-bypass-domains", "networksetup", true],
    ["get-proxy-auto-discovery", "networksetup", true],
  ] as const;
  invariant(
    Array.isArray(value.requests) && value.requests.length === expected.length,
    "Sanitized fixture request count is invalid.",
  );
  value.requests.forEach((candidate, index) => {
    invariant(isRecord(candidate), `Sanitized request ${index} is invalid.`);
    assertExactKeys(
      candidate,
      ["operand", "requestKind", "result", "tool"],
      `Sanitized request ${index}`,
    );
    const [requestKind, tool, needsOperand] = expected[index]!;
    invariant(
      candidate.requestKind === requestKind && candidate.tool === tool,
      `Sanitized request ${index} identity is non-canonical.`,
    );
    if (needsOperand) {
      invariant(isRecord(candidate.operand), `Sanitized request ${index} operand is missing.`);
      assertExactKeys(candidate.operand, ["networkService"], `Sanitized request ${index} operand`);
      invariant(
        typeof candidate.operand.networkService === "string" &&
          /^network-service-\d+$/u.test(candidate.operand.networkService),
        `Sanitized request ${index} operand is not synthetic.`,
      );
    } else {
      invariant(
        candidate.operand === null,
        `Sanitized request ${index} has an unexpected operand.`,
      );
    }
    invariant(isRecord(candidate.result), `Sanitized request ${index} result is invalid.`);
    const resultKind = candidate.result.kind;
    invariant(
      typeof resultKind === "string" &&
        [
          "failed",
          "output-too-large",
          "permission-denied",
          "success",
          "timed-out",
          "unavailable",
        ].includes(resultKind),
      `Sanitized request ${index} result kind is open.`,
    );
    if (resultKind !== "success") {
      assertExactKeys(candidate.result, ["kind"], `Sanitized request ${index} result`);
      return;
    }
    assertExactKeys(candidate.result, ["kind", "stdout"], `Sanitized request ${index} result`);
    invariant(
      isBoundedString(candidate.result.stdout, sanitizedOutputMaximumBytes),
      `Sanitized request ${index} output is oversized.`,
    );
    const stdout = candidate.result.stdout;
    switch (requestKind) {
      case "default-route":
        invariant(
          /^route to: default\ninterface: interface-\d+\n$/u.test(stdout),
          "Sanitized route output is not closed.",
        );
        break;
      case "list-network-service-order":
        invariant(
          /^\(1\) network-service-\d+\n\(Hardware Port: hardware-port-\d+, Device: interface-\d+\)\n$/u.test(
            stdout,
          ),
          "Sanitized network-service output is not closed.",
        );
        break;
      case "get-http-proxy":
      case "get-https-proxy":
      case "get-socks-proxy": {
        const proxy = keyValueLines(stdout, [
          "Authenticated Proxy Enabled",
          "Enabled",
          "Port",
          "Server",
        ]);
        parseBoolean(requiredValue(proxy, "Enabled"), "Sanitized Proxy Enabled");
        invariant(
          /^(?:|proxy-host-\d+\.fixture\.invalid)$/u.test(requiredValue(proxy, "Server")) &&
            /^(?:0|4\d{4})$/u.test(requiredValue(proxy, "Port")) &&
            /^(?:0|1)$/u.test(requiredValue(proxy, "Authenticated Proxy Enabled")),
          "Sanitized proxy output contains a non-synthetic value.",
        );
        break;
      }
      case "get-auto-proxy-url": {
        const automatic = keyValueLines(stdout, ["Enabled", "URL"]);
        parseBoolean(requiredValue(automatic, "Enabled"), "Sanitized Automatic Proxy Enabled");
        invariant(
          /^(?:\(null\)|https?:\/\/proxy-host-\d+\.fixture\.invalid\/proxy\.pac)$/u.test(
            requiredValue(automatic, "URL"),
          ),
          "Sanitized automatic proxy output contains a non-synthetic value.",
        );
        break;
      }
      case "get-proxy-bypass-domains":
        invariant(
          strictLines(stdout).every(
            (line) =>
              line === "There aren't any bypass domains set on network-service-1." ||
              /^(?:\*\.)?domain-\d+\.fixture\.invalid$/u.test(line),
          ),
          "Sanitized bypass output contains a non-synthetic value.",
        );
        break;
      case "get-proxy-auto-discovery":
        invariant(
          /^Auto Proxy Discovery: (?:On|Off)\n$/u.test(stdout),
          "Sanitized discovery output is not closed.",
        );
        break;
    }
  });

  invariant(
    Array.isArray(value.toolEvidence) &&
      normalizedJson(value.toolEvidence) ===
        normalizedJson([
          {
            identity: "networksetup",
            pathClass: "macos-system-networksetup",
            versionEvidence: "not-observable",
          },
          {
            identity: "route",
            pathClass: "macos-system-route",
            versionEvidence: "not-observable",
          },
        ]),
    "Sanitized fixture tool evidence is invalid.",
  );
  invariant(
    value.provenance.sanitizedTranscriptSha256 === digest(normalizedJson(value.requests)),
    "Sanitized fixture digest does not match its request/result content.",
  );
  invariant(
    Buffer.byteLength(normalizedJson(value)) <= 65_536,
    "Sanitized fixture exceeds its schema size bound.",
  );
}

export function compileTranscript(
  rawValue: unknown,
  options: CompileOptions,
): {
  fixture: SanitizedTranscript;
  privacyDiff: string;
} {
  invariant(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(options.fixtureId),
    "Fixture ID is not allowlisted.",
  );
  invariant(
    options.sourceKind === "real-tart-capture" || options.sourceKind === "synthetic-test",
    "Fixture source kind is not closed.",
  );
  const raw = parseRawTranscript(rawValue);
  const expectedOrder: RequestKind[] = [
    "macos-product-version",
    "macos-build-version",
    "macos-architecture",
    "default-route",
    "list-network-service-order",
    "get-http-proxy",
    "get-https-proxy",
    "get-socks-proxy",
    "get-auto-proxy-url",
    "get-proxy-bypass-domains",
    "get-proxy-auto-discovery",
  ];
  invariant(
    raw.records.every((record, index) => record.requestKind === expectedOrder[index]),
    "Raw transcript command sequence differs from the fixed capture policy.",
  );
  for (const record of raw.records.slice(0, 5))
    validateRecordIdentity(record, expectedDefinition(record.requestKind));

  const productVersion = successfulOutput(raw.records[0]!).trim();
  const buildVersion = successfulOutput(raw.records[1]!).trim();
  const architecture = successfulOutput(raw.records[2]!).trim();
  invariant(/^\d{2}\.\d+(?:\.\d+)?$/u.test(productVersion), "macOS product version is malformed.");
  invariant(/^\d{2}[A-Z][A-Za-z0-9]+$/u.test(buildVersion), "macOS build version is malformed.");
  invariant(
    architecture === "arm64" || architecture === "x86_64",
    "macOS architecture is unsupported.",
  );
  const route = parseRoute(successfulOutput(raw.records[3]!));
  const serviceMetadata = parseServiceOrder(successfulOutput(raw.records[4]!), route.interfaceName);
  for (const record of raw.records.slice(5))
    validateRecordIdentity(record, expectedDefinition(record.requestKind, serviceMetadata.service));

  const pseudonyms = new Pseudonyms();
  const syntheticInterface = pseudonyms.map("interface", route.interfaceName);
  const syntheticService = pseudonyms.map("service", serviceMetadata.service);
  const syntheticHardwarePort = pseudonyms.map("hardware-port", serviceMetadata.hardwarePort);
  const requests: SanitizedTranscript["requests"] = raw.records.slice(3).map((record) => {
    const operand =
      record.requestKind === "default-route" || record.requestKind === "list-network-service-order"
        ? null
        : { networkService: syntheticService };
    const tool = record.program === "/sbin/route" ? "route" : "networksetup";
    if (record.result.kind !== "success") {
      return {
        operand,
        requestKind: record.requestKind as SanitizedRequestKind,
        result: normalizedError(record),
        tool,
      };
    }
    let stdout: string;
    switch (record.requestKind) {
      case "default-route":
        stdout = `route to: default\ninterface: ${syntheticInterface}\n`;
        break;
      case "list-network-service-order":
        stdout = `(1) ${syntheticService}\n(Hardware Port: ${syntheticHardwarePort}, Device: ${syntheticInterface})\n`;
        break;
      case "get-http-proxy":
      case "get-https-proxy":
      case "get-socks-proxy":
        stdout = sanitizeManualProxy(record.result.stdout, pseudonyms);
        break;
      case "get-auto-proxy-url":
        stdout = sanitizePac(record.result.stdout, pseudonyms);
        break;
      case "get-proxy-bypass-domains":
        stdout = sanitizeBypass(record.result.stdout, pseudonyms);
        break;
      case "get-proxy-auto-discovery":
        stdout = sanitizeDiscovery(record.result.stdout);
        break;
      default:
        throw new Error(`Metadata request ${record.requestKind} escaped fixture filtering.`);
    }
    invariant(
      Buffer.byteLength(stdout) <= sanitizedOutputMaximumBytes,
      "Sanitized command output is oversized.",
    );
    return {
      operand,
      requestKind: record.requestKind as SanitizedRequestKind,
      result: { kind: "success", stdout },
      tool,
    };
  });
  const productVersionFamily = `${productVersion.split(".")[0]}.x`;
  const buildFamily = buildVersion.slice(0, 3);
  const captureEnvironment =
    options.sourceKind === "real-tart-capture" ? "disposable-tart-clone" : "repository-synthetic";
  const transcriptDigest = digest(normalizedJson(requests));
  const fixture: SanitizedTranscript = {
    architecture,
    buildFamily,
    fixtureKind: "macos-command-runner-system-proxy",
    locale: "C",
    platformFamily: "macos",
    productVersionFamily,
    provenance: {
      captureEnvironment,
      capturePolicy: transcriptCapturePolicy,
      compiler: "macos-platform-transcript-v1",
      fixtureId: options.fixtureId,
      sanitizedTranscriptSha256: transcriptDigest,
      sourceKind: options.sourceKind,
    },
    requests,
    schemaVersion: transcriptSchemaVersion,
    toolEvidence: [
      {
        identity: "networksetup",
        pathClass: "macos-system-networksetup",
        versionEvidence: "not-observable",
      },
      { identity: "route", pathClass: "macos-system-route", versionEvidence: "not-observable" },
    ],
  };
  const counts = pseudonyms.counts();
  const privacyDiff = [
    "# macOS platform transcript privacy diff",
    "",
    `- Fixture: \`${options.fixtureId}\``,
    `- Source: \`${options.sourceKind}\``,
    "- Raw values included: **none**",
    "- Unknown fields: rejected",
    "- Secrets, credentials, Profile/configuration bytes, traffic, packet data, process lists, unrelated routes, and remote targets: rejected by the closed capture/schema boundary",
    `- Network services: ${counts.service} distinct source value(s) mapped to relation-preserving synthetic identifiers`,
    `- Interfaces: ${counts.interface} distinct source value(s) mapped to relation-preserving synthetic identifiers`,
    `- Hardware ports: ${counts["hardware-port"]} distinct source value(s) mapped to relation-preserving synthetic identifiers`,
    `- Proxy/PAC hosts: ${counts.host} distinct source value(s) mapped to relation-preserving \`.fixture.invalid\` hosts`,
    `- Proxy ports: ${counts.port} distinct nonzero source value(s) mapped to relation-preserving synthetic ports`,
    `- Bypass/search domains: ${counts.domain} distinct source value(s) mapped to relation-preserving \`.fixture.invalid\` domains`,
    `- Sanitized transcript SHA-256: \`${transcriptDigest}\``,
    "",
    "The digest covers only the sanitized request/result array; it is not a fingerprint of quarantined raw evidence.",
    "",
  ].join("\n");
  invariant(
    !privacyDiff.includes(serviceMetadata.service) && !privacyDiff.includes(route.interfaceName),
    "Privacy diff retained a raw identifier.",
  );
  validateSanitizedTranscript(fixture);
  return { fixture, privacyDiff };
}

async function cleanupDirectory(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  invariant(entries.length <= 4, "Quarantine contains too many entries for bounded cleanup.");
  for (const entry of entries) {
    invariant(
      entry.isFile() && !entry.isSymbolicLink(),
      "Quarantine cleanup refuses nested or special entries.",
    );
    invariant(
      entry.name === rawTranscriptFileName || entry.name === sensitiveMarkerFileName,
      `Quarantine cleanup refuses unexpected entry: ${entry.name}.`,
    );
    await unlink(path.join(root, entry.name));
  }
  await rmdir(root);
}

export async function cleanupQuarantine(inputRoot: string): Promise<void> {
  await cleanupDirectory(await validateExistingQuarantineRoot(inputRoot));
}

async function validateOutputPath(output: string, pattern: RegExp): Promise<string> {
  const resolved = path.resolve(output);
  invariant(
    path.dirname(resolved) === fixtureRoot && pattern.test(path.basename(resolved)),
    "Sanitized output path is outside the versioned fixture root or has an invalid name.",
  );
  await mkdir(fixtureRoot, { recursive: true });
  invariant(
    (await realpath(fixtureRoot)) === fixtureRoot,
    "Versioned fixture root must not resolve through a symlink.",
  );
  try {
    await lstat(resolved);
    throw new Error("Sanitized output already exists; overwrite is refused.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolved;
}

async function writeNewFileAtomically(output: string, content: string): Promise<void> {
  const temporary = `${output}.pending`;
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, output);
}

export async function compileQuarantine(
  options: CompileOptions & {
    cleanup?: Cleanup;
    fixtureOutput: string;
    inputRoot: string;
    privacyDiffOutput: string;
  },
): Promise<void> {
  const root = await validateExistingQuarantineRoot(options.inputRoot);
  const entries = (await readdir(root)).sort();
  invariant(
    JSON.stringify(entries) ===
      JSON.stringify([sensitiveMarkerFileName, rawTranscriptFileName].sort()),
    "Quarantine has missing or unexpected entries.",
  );
  const rawPath = path.join(root, rawTranscriptFileName);
  const markerPath = path.join(root, sensitiveMarkerFileName);
  const metadata = await lstat(rawPath);
  const markerMetadata = await lstat(markerPath);
  invariant(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 1 &&
      (metadata.mode & 0o077) === 0 &&
      (process.getuid === undefined || metadata.uid === process.getuid()) &&
      metadata.size <= rawTranscriptMaximumBytes,
    "Raw transcript file metadata is invalid.",
  );
  invariant(
    markerMetadata.isFile() &&
      !markerMetadata.isSymbolicLink() &&
      markerMetadata.nlink === 1 &&
      (markerMetadata.mode & 0o077) === 0 &&
      (process.getuid === undefined || markerMetadata.uid === process.getuid()) &&
      markerMetadata.size <= 256,
    "Sensitive marker file metadata is invalid.",
  );
  const raw = JSON.parse(await readFile(rawPath, "utf8")) as unknown;
  const compiled = compileTranscript(raw, options);
  const fixtureOutput = await validateOutputPath(options.fixtureOutput, fixtureName);
  const privacyDiffOutput = await validateOutputPath(options.privacyDiffOutput, privacyDiffName);
  invariant(
    path.basename(fixtureOutput, ".json") === path.basename(privacyDiffOutput, ".privacy.md"),
    "Fixture and privacy diff names must match.",
  );
  await writeNewFileAtomically(fixtureOutput, normalizedJson(compiled.fixture));
  try {
    await writeNewFileAtomically(privacyDiffOutput, compiled.privacyDiff);
    await (options.cleanup ?? cleanupQuarantine)(root);
  } catch (error) {
    await unlink(fixtureOutput).catch(() => undefined);
    await unlink(privacyDiffOutput).catch(() => undefined);
    throw new Error(
      "Raw cleanup failed; sanitized outputs were removed and the fixture is not accepted.",
      { cause: error },
    );
  }
}

function parseCli(arguments_: string[]): { action: string; options: Map<string, string> } {
  const [action, ...rest] = arguments_;
  invariant(
    action === "record" || action === "compile" || action === "abort",
    "Usage: macos-platform-transcript <record|compile|abort> with explicit named options.",
  );
  invariant(rest.length % 2 === 0, "Every command option requires one value.");
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]!;
    const value = rest[index + 1]!;
    invariant(
      name.startsWith("--") && !options.has(name),
      "Command options must be unique named arguments.",
    );
    invariant(value.length > 0 && !value.startsWith("--"), `Option ${name} has no value.`);
    options.set(name, value);
  }
  const allowed =
    action === "record" || action === "abort"
      ? ["--output-root"]
      : ["--fixture-id", "--fixture-out", "--input-root", "--privacy-diff-out", "--source"];
  invariant(
    options.size === allowed.length && [...options.keys()].every((key) => allowed.includes(key)),
    "Command contains missing or unallowlisted options.",
  );
  return { action, options };
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  invariant(value, `Missing required option ${name}.`);
  return value;
}

export async function runCli(arguments_: string[]): Promise<void> {
  const { action, options } = parseCli(arguments_);
  const outputRoot = options.get("--output-root");
  if (action === "record") {
    await recordTranscript(requiredOption(options, "--output-root"));
    process.stdout.write("Sensitive raw capture completed inside the approved guest quarantine.\n");
    return;
  }
  if (action === "abort") {
    await cleanupQuarantine(requiredOption(options, "--output-root"));
    process.stdout.write("Sensitive raw capture quarantine deleted.\n");
    return;
  }
  invariant(outputRoot === undefined, "Compile does not accept an output-root alias.");
  const source = requiredOption(options, "--source");
  invariant(
    source === "real-tart" || source === "synthetic",
    "Compile source must be real-tart or synthetic.",
  );
  await compileQuarantine({
    fixtureId: requiredOption(options, "--fixture-id"),
    fixtureOutput: requiredOption(options, "--fixture-out"),
    inputRoot: requiredOption(options, "--input-root"),
    privacyDiffOutput: requiredOption(options, "--privacy-diff-out"),
    sourceKind: source === "real-tart" ? "real-tart-capture" : "synthetic-test",
  });
  process.stdout.write(
    "Sanitized fixture and privacy diff created; sensitive raw quarantine deleted.\n",
  );
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "macOS platform transcript command failed"}\n`,
    );
    process.exitCode = 1;
  });
}
