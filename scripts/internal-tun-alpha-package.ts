import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const internalTunAlphaProfile = "internal-tun-alpha" as const;
export const internalTunAlphaManifestName = "internal-tun-alpha-manifest.json";
export const internalTunAlphaPackageVersion = "0.1.0-internal-tun-alpha.1";
export const internalTunAlphaIdentityScheme = "sha256-helper-core-rendered-plist-v1" as const;

const fixedTimestamp = new Date("2020-01-01T00:00:00.000Z");
const manifestMaximumBytes = 64 * 1024;
const packageFileMaximumBytes = 256 * 1024 * 1024;
const packageRootName = `Mish-Internal-TUN-Alpha-${internalTunAlphaPackageVersion}-arm64`;
const controllerRelativePath = "Resources/mish-internal-tun-alpha-ctl";
const helperRelativePath = "Resources/mish-tun-helper";
const coreRelativePath = "Resources/mihomo";
const plistTemplateRelativePath = "Resources/com.asuka109.mish.tun-helper.dev.plist.template";

type InternalTunAlphaRole =
  | "controller"
  | "core"
  | "health"
  | "helper"
  | "install"
  | "launch-daemon-template"
  | "license"
  | "notice"
  | "notices"
  | "repair"
  | "status"
  | "uninstall";

export type InternalTunAlphaManifestFile = {
  mode: number;
  path: string;
  role: InternalTunAlphaRole;
  sha256: string;
  size: number;
};

export type InternalTunAlphaManifest = {
  allowTun: false;
  architecture: "arm64";
  coreVersion: string;
  developerIdRequired: false;
  files: InternalTunAlphaManifestFile[];
  helperVersion: string;
  installationIdentityScheme: typeof internalTunAlphaIdentityScheme;
  minimumMacosVersion: 13;
  networkMutationEnabled: false;
  packageVersion: string;
  profile: typeof internalTunAlphaProfile;
  protocolVersion: 3;
  schemaVersion: 1;
};

export type InternalTunAlphaVerificationOptions = {
  expectedOwnerUid?: number;
  validateMacOsBinaries?: boolean;
};

const expectedFiles: ReadonlyArray<{
  mode: number;
  path: string;
  role: InternalTunAlphaRole;
}> = [
  { mode: 0o755, path: "Health Internal TUN Alpha.command", role: "health" },
  { mode: 0o755, path: "Install Internal TUN Alpha.command", role: "install" },
  { mode: 0o644, path: "LICENSE", role: "license" },
  { mode: 0o644, path: "README.txt", role: "notice" },
  { mode: 0o755, path: "Repair Internal TUN Alpha.command", role: "repair" },
  { mode: 0o755, path: controllerRelativePath, role: "controller" },
  {
    mode: 0o644,
    path: plistTemplateRelativePath,
    role: "launch-daemon-template",
  },
  { mode: 0o755, path: coreRelativePath, role: "core" },
  { mode: 0o755, path: helperRelativePath, role: "helper" },
  { mode: 0o755, path: "Status Internal TUN Alpha.command", role: "status" },
  { mode: 0o644, path: "THIRD_PARTY_NOTICES.md", role: "notices" },
  { mode: 0o755, path: "Uninstall Internal TUN Alpha.command", role: "uninstall" },
] as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function digestFile(file: string): Promise<string> {
  return digest(await readFile(file));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    value.split("/").every((component) => component && component !== "." && component !== "..")
  );
}

async function validateDirectory(directory: string, ownerUid: number): Promise<void> {
  const metadata = await lstat(directory);
  invariant(
    metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === ownerUid &&
      (metadata.mode & 0o022) === 0,
    `Internal TUN Alpha directory metadata was rejected: ${directory}`,
  );
}

async function validateFile(
  file: string,
  ownerUid: number,
  mode: number,
  size?: number,
): Promise<void> {
  const metadata = await lstat(file);
  invariant(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === ownerUid &&
      metadata.nlink === 1 &&
      (metadata.mode & 0o777) === mode &&
      metadata.size > 0 &&
      (size === undefined || metadata.size === size),
    `Internal TUN Alpha file metadata was rejected: ${file}`,
  );
}

async function walk(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const metadata = await lstat(absolute);
      invariant(!metadata.isSymbolicLink(), `Internal TUN Alpha rejects symlinks: ${relative}`);
      if (metadata.isDirectory()) return [relative, ...(await walk(root, absolute))];
      invariant(metadata.isFile(), `Internal TUN Alpha rejects special files: ${relative}`);
      return [relative];
    }),
  );
  return nested.flat().sort();
}

function expectedContract(): string {
  return JSON.stringify(
    expectedFiles.map(({ mode, path: file, role }) => ({ mode, path: file, role })),
  );
}

export async function createInternalTunAlphaManifest(
  root: string,
  versions: { coreVersion: string; helperVersion: string },
): Promise<InternalTunAlphaManifest> {
  const files = await Promise.all(
    expectedFiles.map(async ({ mode, path: relative, role }) => {
      const absolute = path.join(root, relative);
      const metadata = await stat(absolute);
      return {
        mode,
        path: relative,
        role,
        sha256: await digestFile(absolute),
        size: metadata.size,
      };
    }),
  );
  return {
    allowTun: false,
    architecture: "arm64",
    coreVersion: versions.coreVersion,
    developerIdRequired: false,
    files,
    helperVersion: versions.helperVersion,
    installationIdentityScheme: internalTunAlphaIdentityScheme,
    minimumMacosVersion: 13,
    networkMutationEnabled: false,
    packageVersion: internalTunAlphaPackageVersion,
    profile: internalTunAlphaProfile,
    protocolVersion: 3,
    schemaVersion: 1,
  };
}

function validateManifestShape(value: unknown): asserts value is InternalTunAlphaManifest {
  invariant(value && typeof value === "object", "Internal TUN Alpha manifest must be an object");
  const manifest = value as Partial<InternalTunAlphaManifest> & Record<string, unknown>;
  const expectedKeys = [
    "allowTun",
    "architecture",
    "coreVersion",
    "developerIdRequired",
    "files",
    "helperVersion",
    "installationIdentityScheme",
    "minimumMacosVersion",
    "networkMutationEnabled",
    "packageVersion",
    "profile",
    "protocolVersion",
    "schemaVersion",
  ].sort();
  invariant(
    JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(expectedKeys),
    "Internal TUN Alpha manifest contains missing or unknown fields",
  );
  invariant(
    manifest.schemaVersion === 1 &&
      manifest.profile === internalTunAlphaProfile &&
      manifest.packageVersion === internalTunAlphaPackageVersion &&
      manifest.architecture === "arm64" &&
      manifest.minimumMacosVersion === 13 &&
      manifest.protocolVersion === 3 &&
      manifest.developerIdRequired === false &&
      manifest.allowTun === false &&
      manifest.networkMutationEnabled === false &&
      manifest.installationIdentityScheme === internalTunAlphaIdentityScheme &&
      typeof manifest.helperVersion === "string" &&
      /^[1-9][0-9]*$/u.test(manifest.helperVersion) &&
      typeof manifest.coreVersion === "string" &&
      /^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(manifest.coreVersion),
    "Internal TUN Alpha profile contract is invalid",
  );
  invariant(
    Array.isArray(manifest.files) && manifest.files.length === expectedFiles.length,
    "Internal TUN Alpha manifest has an invalid file count",
  );
  for (const file of manifest.files) {
    invariant(
      file &&
        typeof file === "object" &&
        JSON.stringify(Object.keys(file).sort()) ===
          JSON.stringify(["mode", "path", "role", "sha256", "size"]) &&
        isSafeRelativePath(file.path) &&
        isDigest(file.sha256) &&
        Number.isSafeInteger(file.size) &&
        file.size > 0 &&
        file.size <= packageFileMaximumBytes,
      "Internal TUN Alpha manifest contains an invalid file entry",
    );
  }
  invariant(
    JSON.stringify(
      manifest.files.map(({ mode, path: file, role }) => ({ mode, path: file, role })),
    ) === expectedContract(),
    "Internal TUN Alpha manifest file contract differs from the closed package layout",
  );
}

function verifyMachOArchitecture(file: string): void {
  const result = spawnSync("/usr/bin/file", ["-b", file], { encoding: "utf8" });
  invariant(
    result.status === 0 && /\bMach-O\b/u.test(result.stdout) && /\barm64\b/u.test(result.stdout),
    `Internal TUN Alpha contains a non-arm64 executable: ${file}`,
  );
}

function verifyAdHocSignature(file: string): void {
  const result = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", file], {
    encoding: "utf8",
  });
  const evidence = `${result.stdout}\n${result.stderr}`;
  invariant(
    result.status === 0 &&
      /^Signature=adhoc$/mu.test(evidence) &&
      /^TeamIdentifier=not set$/mu.test(evidence) &&
      !/^Authority=/mu.test(evidence),
    `Internal TUN Alpha executable is not ad-hoc-only: ${file}`,
  );
}

export async function verifyInternalTunAlphaPackage(
  root: string,
  options: InternalTunAlphaVerificationOptions = {},
): Promise<InternalTunAlphaManifest> {
  invariant(path.isAbsolute(root), "Internal TUN Alpha package root must be absolute");
  invariant(path.resolve(root) === root, "Internal TUN Alpha package root must be canonical");
  invariant((await realpath(root)) === root, "Internal TUN Alpha package root contains symlinks");
  const ownerUid = options.expectedOwnerUid ?? process.getuid?.();
  invariant(ownerUid !== undefined, "Internal TUN Alpha package owner is unavailable");
  await validateDirectory(root, ownerUid);
  await validateDirectory(path.join(root, "Resources"), ownerUid);

  const manifestFile = path.join(root, internalTunAlphaManifestName);
  const manifestMetadata = await lstat(manifestFile);
  invariant(
    manifestMetadata.size > 0 && manifestMetadata.size <= manifestMaximumBytes,
    "Internal TUN Alpha manifest size is invalid",
  );
  await validateFile(manifestFile, ownerUid, 0o644, manifestMetadata.size);
  const manifestBytes = await readFile(manifestFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Internal TUN Alpha manifest is malformed");
  }
  validateManifestShape(parsed);

  for (const file of parsed.files) {
    const absolute = path.join(root, file.path);
    await validateFile(absolute, ownerUid, file.mode, file.size);
    invariant(
      (await digestFile(absolute)) === file.sha256,
      `Internal TUN Alpha digest differs: ${file.path}`,
    );
  }
  const discovered = await walk(root);
  const expected = [
    ...expectedFiles.map(({ path: file }) => file),
    "Resources",
    internalTunAlphaManifestName,
  ].sort();
  invariant(
    JSON.stringify(discovered) === JSON.stringify(expected),
    "Internal TUN Alpha package contains unexpected, duplicate, or missing files",
  );

  const template = await readFile(path.join(root, plistTemplateRelativePath), "utf8");
  for (const placeholder of [
    "__MISH_ALLOWED_UID__",
    "__MISH_INSTALLATION_ID__",
    "__MISH_RUNTIME_ROOT_XML__",
    "__MISH_SOCKET__",
  ]) {
    invariant(
      template.split(placeholder).length === 2,
      `Internal TUN Alpha LaunchDaemon template has an invalid ${placeholder} placeholder`,
    );
  }
  invariant(
    template.includes("<key>MISH_TUN_SERVICE_ALLOW_TUN</key><string>0</string>") &&
      !template.includes("<string>1</string>") &&
      template.includes("/Library/PrivilegedHelperTools/com.asuka109.mish.tun-helper.dev") &&
      template.includes("/Library/PrivilegedHelperTools/com.asuka109.mish.mihomo.dev") &&
      template.includes(
        "/Library/Application Support/com.asuka109.mish/tun-helper-dev/enrollment.json",
      ),
    "Internal TUN Alpha LaunchDaemon template does not preserve the disabled fixed-path policy",
  );

  if (options.validateMacOsBinaries ?? true) {
    invariant(
      process.platform === "darwin" && process.arch === "arm64",
      "Live Internal TUN Alpha verification requires Apple Silicon macOS",
    );
    for (const relative of [controllerRelativePath, helperRelativePath, coreRelativePath]) {
      verifyMachOArchitecture(path.join(root, relative));
    }
    verifyAdHocSignature(path.join(root, controllerRelativePath));
    verifyAdHocSignature(path.join(root, helperRelativePath));
    const core = path.join(root, coreRelativePath);
    const coreVersion = execFileSync(core, ["-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    invariant(
      coreVersion.split(/\s+/u).includes(parsed.coreVersion),
      "Internal TUN Alpha Core version differs from the manifest",
    );
  }
  return parsed;
}

function commandResource(action: "health" | "install" | "repair" | "status" | "uninstall") {
  return `#!/bin/sh
set -eu
PACKAGE_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
exec "$PACKAGE_ROOT/Resources/mish-internal-tun-alpha-ctl" ${action} "$PACKAGE_ROOT"
`;
}

const readme = `Mish Internal TUN Alpha

This Developer-ID-free package is for explicitly trusted internal distribution.
It is ad-hoc signed, not Apple-trusted, not notarized, and not a public release.
Gatekeeper may require one package-scoped Open Anyway confirmation.

Double-click Install Internal TUN Alpha.command and approve the visible macOS
administrator prompt. Installation starts healthy and disabled. It does not
enable TUN, change routes, DNS, System Proxy, or other network state.

Use Health Internal TUN Alpha.command to verify the exact package manifest,
installed Helper/Core/LaunchDaemon/receipts, P-256 enrollment, protocol, and a
fresh disabled observation. Repair replaces only fixed Mish-owned artifacts.
Uninstall removes the service, Core, socket, receipts, enrollment, and client
key while preserving unrelated system and user state.

The private P-256 key is a user-owned mode-0600 file. This blocks clients that
cannot read it, but it cannot resist malware or another process already running
as the same user. Do not treat this package as production trust.
`;

async function copyWithMode(source: string, destination: string, mode: number): Promise<void> {
  await copyFile(source, destination);
  await chmod(destination, mode);
}

function signAdHoc(file: string, identifier: string): void {
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, file], {
    stdio: "inherit",
  });
}

async function setFixedTimes(root: string): Promise<void> {
  for (const relative of (await walk(root)).reverse()) {
    await utimes(path.join(root, relative), fixedTimestamp, fixedTimestamp);
  }
  await utimes(root, fixedTimestamp, fixedTimestamp);
}

function pinnedCoreSource(release: { asset: string; version: string }): string {
  return path.resolve(".scratch/mihomo", release.version, release.asset.replace(/\.gz$/u, ""));
}

export async function buildInternalTunAlphaPackage(): Promise<{
  archive: string;
  manifestSha256: string;
  packageRoot: string;
}> {
  invariant(
    process.platform === "darwin" && process.arch === "arm64",
    "Internal TUN Alpha packaging requires Apple Silicon macOS",
  );
  const repositoryRoot = path.resolve(".");
  const helperContract = await readFile(
    path.join(repositoryRoot, "crates/runtime/src/tun_helper.rs"),
    "utf8",
  );
  const helperVersionMatches = [
    ...helperContract.matchAll(/pub const TUN_HELPER_EXPECTED_VERSION: &str = "([1-9][0-9]*)";/gu),
  ];
  invariant(
    helperVersionMatches.length === 1,
    "Internal TUN Alpha Helper version contract is invalid",
  );
  const helperVersion = helperVersionMatches[0]?.[1];
  invariant(helperVersion !== undefined, "Internal TUN Alpha Helper version is unavailable");
  const release = JSON.parse(
    await readFile(path.join(repositoryRoot, "resources/mihomo/macos-arm64.json"), "utf8"),
  ) as {
    asset: string;
    binarySha256: string;
    schemaVersion: number;
    version: string;
  };
  invariant(
    release.schemaVersion === 1 &&
      /^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(release.version) &&
      isDigest(release.binarySha256),
    "Pinned macOS Core manifest is invalid",
  );
  const coreSource = pinnedCoreSource(release);
  try {
    await lstat(coreSource);
  } catch {
    execFileSync(process.execPath, ["scripts/prepare-mihomo.ts"], { stdio: "inherit" });
  }
  invariant(
    (await digestFile(coreSource)) === release.binarySha256,
    "Pinned macOS Core digest differs before packaging",
  );
  const coreVersion = execFileSync(coreSource, ["-v"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  invariant(
    coreVersion.split(/\s+/u).includes(release.version),
    "Pinned macOS Core version differs before packaging",
  );

  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "-p",
      "mish-platform-macos",
      "--features",
      "development-core-host",
      "--bin",
      "mish-tun-helper",
      "--bin",
      "mish-internal-tun-alpha-ctl",
    ],
    { stdio: "inherit" },
  );

  const outputParent = path.join(repositoryRoot, "target/internal-tun-alpha");
  await mkdir(outputParent, { recursive: true, mode: 0o755 });
  const outputRoot = path.join(outputParent, packageRootName);
  try {
    await lstat(outputRoot);
    throw new Error(
      `Internal TUN Alpha output already exists; move it to Trash before rebuilding: ${outputRoot}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(path.join(outputParent, ".staging-"));
  const packageRoot = path.join(staging, packageRootName);
  const resources = path.join(packageRoot, "Resources");
  await mkdir(resources, { recursive: true, mode: 0o755 });

  await copyWithMode(
    path.join(repositoryRoot, "target/release/mish-internal-tun-alpha-ctl"),
    path.join(packageRoot, controllerRelativePath),
    0o755,
  );
  await copyWithMode(
    path.join(repositoryRoot, "target/release/mish-tun-helper"),
    path.join(packageRoot, helperRelativePath),
    0o755,
  );
  await copyWithMode(coreSource, path.join(packageRoot, coreRelativePath), 0o755);
  await copyWithMode(
    path.join(
      repositoryRoot,
      "resources/internal-tun-alpha/com.asuka109.mish.tun-helper.dev.plist.template",
    ),
    path.join(packageRoot, plistTemplateRelativePath),
    0o644,
  );
  await copyWithMode(
    path.join(repositoryRoot, "LICENSE"),
    path.join(packageRoot, "LICENSE"),
    0o644,
  );
  await copyWithMode(
    path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"),
    path.join(packageRoot, "THIRD_PARTY_NOTICES.md"),
    0o644,
  );
  await writeFile(path.join(packageRoot, "README.txt"), readme, { mode: 0o644 });
  for (const action of ["health", "install", "repair", "status", "uninstall"] as const) {
    const title = `${action[0].toUpperCase()}${action.slice(1)} Internal TUN Alpha.command`;
    await writeFile(path.join(packageRoot, title), commandResource(action), { mode: 0o755 });
    await chmod(path.join(packageRoot, title), 0o755);
  }

  signAdHoc(path.join(packageRoot, controllerRelativePath), "com.asuka109.mish.internal-tun-alpha");
  signAdHoc(path.join(packageRoot, helperRelativePath), "com.asuka109.mish.tun-helper.dev");
  invariant(
    (await digestFile(path.join(packageRoot, coreRelativePath))) === release.binarySha256,
    "Packaging changed the exact pinned Core",
  );

  const manifest = await createInternalTunAlphaManifest(packageRoot, {
    coreVersion: release.version,
    helperVersion,
  });
  await writeFile(
    path.join(packageRoot, internalTunAlphaManifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  await chmod(path.join(packageRoot, internalTunAlphaManifestName), 0o644);
  await setFixedTimes(packageRoot);
  await verifyInternalTunAlphaPackage(packageRoot);
  await rename(packageRoot, outputRoot);
  await rmdir(staging);

  const archive = path.join(outputParent, `${packageRootName}.tar.gz`);
  try {
    await lstat(archive);
    throw new Error(
      `Internal TUN Alpha archive already exists; move it to Trash before rebuilding: ${archive}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tar = archive.replace(/\.gz$/u, "");
  const archivePaths = [
    packageRootName,
    `${packageRootName}/Resources`,
    ...expectedFiles.map(({ path: relative }) => `${packageRootName}/${relative}`),
    `${packageRootName}/${internalTunAlphaManifestName}`,
  ].sort((left, right) => {
    const depth = (value: string) => value.split("/").length;
    return depth(left) - depth(right) || left.localeCompare(right);
  });
  execFileSync(
    "/usr/bin/tar",
    [
      "-cf",
      tar,
      "--format",
      "ustar",
      "--no-recursion",
      "--uid",
      "0",
      "--gid",
      "0",
      "--uname",
      "root",
      "--gname",
      "wheel",
      "-C",
      outputParent,
      ...archivePaths,
    ],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: "inherit",
    },
  );
  execFileSync("/usr/bin/gzip", ["-n", "-9", tar], { stdio: "inherit" });
  const archiveEntries = execFileSync("/usr/bin/tar", ["-tf", archive], {
    encoding: "utf8",
  }).trim();
  invariant(
    archiveEntries.length > 0 &&
      !archiveEntries.split("\n").some((entry) => entry.includes("/._") || entry.includes("../")),
    "Internal TUN Alpha archive contains unsafe metadata or paths",
  );
  return {
    archive,
    manifestSha256: await digestFile(path.join(outputRoot, internalTunAlphaManifestName)),
    packageRoot: outputRoot,
  };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_[1] === "--") arguments_.splice(1, 1);
  const [action, argument, ...extra] = arguments_;
  invariant(extra.length === 0, "Internal TUN Alpha package command received extra arguments");
  if (action === "build" && argument === undefined) {
    const result = await buildInternalTunAlphaPackage();
    console.log(JSON.stringify({ ...result, ok: true, profile: internalTunAlphaProfile }));
    return;
  }
  if (action === "verify" && argument) {
    const root = path.resolve(argument);
    const manifest = await verifyInternalTunAlphaPackage(root);
    console.log(
      JSON.stringify({
        manifestSha256: await digestFile(path.join(root, internalTunAlphaManifestName)),
        ok: true,
        packageVersion: manifest.packageVersion,
        profile: manifest.profile,
      }),
    );
    return;
  }
  throw new Error("Usage: node scripts/internal-tun-alpha-package.ts <build|verify PACKAGE_ROOT>");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Internal TUN Alpha packaging failed");
    process.exitCode = 1;
  }
}
