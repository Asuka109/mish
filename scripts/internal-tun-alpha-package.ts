import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
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
export const internalTunAlphaPackageVersion = "0.1.0-internal-tun-alpha.7";
export const internalTunAlphaIdentityScheme = "sha256-helper-core-rendered-plist-v1" as const;
export const internalTunAlphaPayloadRelativePath = "Contents/Resources/internal-tun-alpha";
export const internalTunAlphaManifestRelativePath = `${internalTunAlphaPayloadRelativePath}/${internalTunAlphaManifestName}`;
export const internalTunAlphaControllerRelativePath = `${internalTunAlphaPayloadRelativePath}/mish-internal-tun-alpha-ctl`;
export const internalTunAlphaHelperRelativePath = `${internalTunAlphaPayloadRelativePath}/mish-tun-helper`;
export const internalTunAlphaCoreRelativePath = `${internalTunAlphaPayloadRelativePath}/mihomo`;
export const internalTunAlphaPlistTemplateRelativePath = `${internalTunAlphaPayloadRelativePath}/com.asuka109.mish.tun-helper.dev.plist.template`;

const fixedTimestamp = new Date("2020-01-01T00:00:00.000Z");
const manifestMaximumBytes = 1024 * 1024;
const packageFileMaximumBytes = 256 * 1024 * 1024;
const packageRootName = `Mish-Internal-TUN-Alpha-${internalTunAlphaPackageVersion}-arm64`;
const applicationSignatureRelativePath = "Contents/_CodeSignature/CodeResources";
const applicationMainExecutableRelativePath = "Contents/MacOS/mish-desktop";

type InternalTunAlphaRole =
  | "application"
  | "controller"
  | "core"
  | "helper"
  | "launch-daemon-template";

export type InternalTunAlphaManifestFile = {
  mode: number;
  path: string;
  role: InternalTunAlphaRole;
  sha256: string;
  size: number;
};

export type InternalTunAlphaManifest = {
  allowTun: true;
  architecture: "arm64";
  coreVersion: string;
  developerIdRequired: false;
  files: InternalTunAlphaManifestFile[];
  helperVersion: string;
  installationIdentityScheme: typeof internalTunAlphaIdentityScheme;
  minimumMacosVersion: 13;
  networkMutationEnabled: true;
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
  { mode: 0o755, path: internalTunAlphaControllerRelativePath, role: "controller" },
  {
    mode: 0o644,
    path: internalTunAlphaPlistTemplateRelativePath,
    role: "launch-daemon-template",
  },
  { mode: 0o755, path: internalTunAlphaCoreRelativePath, role: "core" },
  { mode: 0o755, path: internalTunAlphaHelperRelativePath, role: "helper" },
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
  application: string,
  versions: { coreVersion: string; helperVersion: string },
): Promise<InternalTunAlphaManifest> {
  const fixedFiles = await Promise.all(
    expectedFiles.map(async ({ mode, path: relative, role }) => {
      const absolute = path.join(application, relative);
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
  const applicationFiles = await Promise.all(
    (await walk(application)).map(async (relative) => {
      if (
        relative === applicationSignatureRelativePath ||
        relative === applicationMainExecutableRelativePath ||
        relative === internalTunAlphaManifestRelativePath ||
        relative.startsWith(`${internalTunAlphaPayloadRelativePath}/`)
      ) {
        return null;
      }
      const absolute = path.join(application, relative);
      const metadata = await stat(absolute);
      if (!metadata.isFile()) return null;
      return {
        mode: metadata.mode & 0o777,
        path: relative,
        role: "application" as const,
        sha256: await digestFile(absolute),
        size: metadata.size,
      };
    }),
  );
  const files = [...fixedFiles, ...applicationFiles.filter((file) => file !== null)].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
  return {
    allowTun: true,
    architecture: "arm64",
    coreVersion: versions.coreVersion,
    developerIdRequired: false,
    files,
    helperVersion: versions.helperVersion,
    installationIdentityScheme: internalTunAlphaIdentityScheme,
    minimumMacosVersion: 13,
    networkMutationEnabled: true,
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
      manifest.allowTun === true &&
      manifest.networkMutationEnabled === true &&
      manifest.installationIdentityScheme === internalTunAlphaIdentityScheme &&
      typeof manifest.helperVersion === "string" &&
      /^[1-9][0-9]*$/u.test(manifest.helperVersion) &&
      typeof manifest.coreVersion === "string" &&
      /^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(manifest.coreVersion),
    "Internal TUN Alpha profile contract is invalid",
  );
  invariant(
    Array.isArray(manifest.files) && manifest.files.length > expectedFiles.length,
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
        (file.mode === 0o644 || file.mode === 0o755) &&
        Number.isSafeInteger(file.size) &&
        file.size > 0 &&
        file.size <= packageFileMaximumBytes,
      "Internal TUN Alpha manifest contains an invalid file entry",
    );
  }
  const declared = new Map(
    manifest.files.map((file) => [
      file.path,
      { mode: file.mode, path: file.path, role: file.role },
    ]),
  );
  invariant(declared.size === manifest.files.length, "Internal TUN Alpha manifest has duplicates");
  invariant(
    JSON.stringify(expectedFiles.map(({ path: file }) => declared.get(file))) ===
      expectedContract(),
    "Internal TUN Alpha manifest fixed file contract differs from the closed package layout",
  );
  const applicationFiles = manifest.files.filter(({ role }) => role === "application");
  invariant(
    applicationFiles.length > 0 &&
      manifest.files.length === expectedFiles.length + applicationFiles.length &&
      applicationFiles.every(
        ({ path: file }) =>
          file.startsWith("Contents/") &&
          file !== applicationSignatureRelativePath &&
          file !== applicationMainExecutableRelativePath &&
          !file.startsWith(`${internalTunAlphaPayloadRelativePath}/`),
      ) &&
      applicationFiles.some(({ path: file }) => file === "Contents/Info.plist") &&
      applicationFiles.some(
        ({ path: file }) => file === "Contents/Resources/mihomo-aarch64-apple-darwin",
      ),
    "Internal TUN Alpha application contract is incomplete",
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

function verifyAdHocBundleSignature(application: string): void {
  const result = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", application], {
    encoding: "utf8",
  });
  invariant(
    result.status === 0,
    `Internal TUN Alpha application signature is invalid: ${application}`,
  );
}

async function applicationRootFromPackageRoot(root: string): Promise<string> {
  invariant(path.isAbsolute(root), "Internal TUN Alpha package root must be absolute");
  invariant(path.resolve(root) === root, "Internal TUN Alpha package root must be canonical");
  invariant((await realpath(root)) === root, "Internal TUN Alpha package root contains symlinks");
  const application = path.basename(root) === "Mish.app" ? root : path.join(root, "Mish.app");
  invariant(
    (await realpath(application)) === application,
    "Internal TUN Alpha application bundle contains symlinks",
  );
  return application;
}

export async function verifyInternalTunAlphaPackage(
  root: string,
  options: InternalTunAlphaVerificationOptions = {},
): Promise<InternalTunAlphaManifest> {
  const application = await applicationRootFromPackageRoot(root);
  const applicationMetadata = await lstat(application);
  const currentUid = process.getuid?.();
  const ownerUid = options.expectedOwnerUid ?? applicationMetadata.uid;
  invariant(ownerUid !== undefined, "Internal TUN Alpha package owner is unavailable");
  invariant(
    options.expectedOwnerUid !== undefined || ownerUid === currentUid || ownerUid === 0,
    "Internal TUN Alpha package owner is not the current user or root",
  );
  if (root !== application) {
    await validateDirectory(root, ownerUid);
    invariant(
      JSON.stringify((await readdir(root)).sort()) === JSON.stringify(["Mish.app"]),
      "Internal TUN Alpha package root contains unexpected installation items",
    );
  }
  await validateDirectory(application, ownerUid);
  await validateDirectory(path.join(application, "Contents"), ownerUid);
  await validateDirectory(path.join(application, internalTunAlphaPayloadRelativePath), ownerUid);
  await validateFile(
    path.join(application, applicationMainExecutableRelativePath),
    ownerUid,
    0o755,
  );

  const manifestFile = path.join(application, internalTunAlphaManifestRelativePath);
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
    const absolute = path.join(application, file.path);
    await validateFile(absolute, ownerUid, file.mode, file.size);
    invariant(
      (await digestFile(absolute)) === file.sha256,
      `Internal TUN Alpha digest differs: ${file.path}`,
    );
  }
  const signature = path.join(application, applicationSignatureRelativePath);
  await validateFile(signature, ownerUid, 0o644);
  const discovered = await walk(application);
  for (const relative of discovered) {
    const absolute = path.join(application, relative);
    if ((await lstat(absolute)).isDirectory()) {
      await validateDirectory(absolute, ownerUid);
    }
  }
  const expected = new Set<string>([
    applicationSignatureRelativePath,
    applicationMainExecutableRelativePath,
    path.posix.dirname(applicationMainExecutableRelativePath),
    path.posix.dirname(applicationSignatureRelativePath),
    internalTunAlphaManifestRelativePath,
  ]);
  for (const file of parsed.files) {
    expected.add(file.path);
    let parent = path.posix.dirname(file.path);
    while (parent !== ".") {
      expected.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const expectedPaths = [...expected].sort();
  invariant(
    JSON.stringify(discovered) === JSON.stringify(expectedPaths),
    "Internal TUN Alpha package contains unexpected, duplicate, or missing files",
  );

  const template = await readFile(
    path.join(application, internalTunAlphaPlistTemplateRelativePath),
    "utf8",
  );
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
    template.includes("<key>MISH_TUN_SERVICE_ALLOW_TUN</key><string>1</string>") &&
      template.includes("/Library/PrivilegedHelperTools/com.asuka109.mish.tun-helper.dev") &&
      template.includes("/Library/PrivilegedHelperTools/com.asuka109.mish.mihomo.dev") &&
      template.includes(
        "/Library/Application Support/com.asuka109.mish/tun-helper-dev/enrollment.json",
      ),
    "Internal TUN Alpha LaunchDaemon template does not preserve the fixed TUN policy",
  );

  if (options.validateMacOsBinaries ?? true) {
    invariant(
      process.platform === "darwin" && process.arch === "arm64",
      "Live Internal TUN Alpha verification requires Apple Silicon macOS",
    );
    for (const relative of [
      internalTunAlphaControllerRelativePath,
      internalTunAlphaHelperRelativePath,
      internalTunAlphaCoreRelativePath,
      applicationMainExecutableRelativePath,
    ]) {
      verifyMachOArchitecture(path.join(application, relative));
    }
    verifyAdHocSignature(path.join(application, internalTunAlphaControllerRelativePath));
    verifyAdHocSignature(path.join(application, internalTunAlphaHelperRelativePath));
    verifyAdHocSignature(application);
    verifyAdHocBundleSignature(application);
    const core = path.join(application, internalTunAlphaCoreRelativePath);
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

async function moveStagingToTrash(directory: string): Promise<void> {
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  execFileSync("trash", [directory], { stdio: "ignore" });
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

  execFileSync("pnpm", ["--filter", "@mish/desktop", "bundle:macos:internal-tun-alpha"], {
    env: {
      ...process.env,
      APPLE_SIGNING_IDENTITY: "-",
      CI: "true",
      MISH_INTERNAL_TUN_PACKAGE_VERSION: internalTunAlphaPackageVersion,
      MISH_MACOS_PACKAGE_MODE: internalTunAlphaProfile,
      MISH_MACOS_RELEASE_PROFILE: internalTunAlphaProfile,
    },
    stdio: "inherit",
  });

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
    {
      env: {
        ...process.env,
        CARGO_INCREMENTAL: "0",
        RUSTFLAGS: [
          `--remap-path-prefix=${repositoryRoot}=.`,
          ...(process.env.HOME ? [`--remap-path-prefix=${process.env.HOME}=~`] : []),
        ].join(" "),
        SOURCE_DATE_EPOCH: String(Math.floor(fixedTimestamp.getTime() / 1000)),
      },
      stdio: "inherit",
    },
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
  try {
    const packageRoot = path.join(staging, packageRootName);
    const application = path.join(packageRoot, "Mish.app");
    const payload = path.join(application, internalTunAlphaPayloadRelativePath);
    await mkdir(packageRoot, { recursive: true, mode: 0o755 });
    await cp(path.join(repositoryRoot, "target/release/bundle/macos/Mish.app"), application, {
      recursive: true,
      preserveTimestamps: false,
    });
    await mkdir(payload, { recursive: true, mode: 0o755 });

    await copyWithMode(
      path.join(repositoryRoot, "target/release/mish-internal-tun-alpha-ctl"),
      path.join(application, internalTunAlphaControllerRelativePath),
      0o755,
    );
    await copyWithMode(
      path.join(repositoryRoot, "target/release/mish-tun-helper"),
      path.join(application, internalTunAlphaHelperRelativePath),
      0o755,
    );
    await copyWithMode(coreSource, path.join(application, internalTunAlphaCoreRelativePath), 0o755);
    await copyWithMode(
      path.join(
        repositoryRoot,
        "resources/internal-tun-alpha/com.asuka109.mish.tun-helper.dev.plist.template",
      ),
      path.join(application, internalTunAlphaPlistTemplateRelativePath),
      0o644,
    );

    signAdHoc(
      path.join(application, internalTunAlphaControllerRelativePath),
      "com.asuka109.mish.internal-tun-alpha",
    );
    signAdHoc(
      path.join(application, internalTunAlphaHelperRelativePath),
      "com.asuka109.mish.tun-helper.dev",
    );
    invariant(
      (await digestFile(path.join(application, internalTunAlphaCoreRelativePath))) ===
        release.binarySha256,
      "Packaging changed the exact pinned Core",
    );

    await setFixedTimes(application);
    // The app seal owns the self-signing main executable. The manifest hashes the
    // remaining application resources and fixed payload before the final seal.
    signAdHoc(application, "com.asuka109.mish");
    await setFixedTimes(application);
    const manifest = await createInternalTunAlphaManifest(application, {
      coreVersion: release.version,
      helperVersion,
    });
    await writeFile(
      path.join(application, internalTunAlphaManifestRelativePath),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o644 },
    );
    await chmod(path.join(application, internalTunAlphaManifestRelativePath), 0o644);
    signAdHoc(application, "com.asuka109.mish");
    await setFixedTimes(application);
    await verifyInternalTunAlphaPackage(packageRoot);
    execFileSync("pnpm", ["desktop:bundle:verify:macos"], {
      env: {
        ...process.env,
        MISH_MACOS_APP_PATH: application,
        MISH_MACOS_PACKAGE_MODE: internalTunAlphaProfile,
      },
      stdio: "inherit",
    });
    await rename(packageRoot, outputRoot);
    await rmdir(staging);
  } catch (error) {
    try {
      await moveStagingToTrash(staging);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Internal TUN Alpha packaging failed and its staging directory could not be cleaned",
      );
    }
    throw error;
  }

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
    ...(await walk(outputRoot)).map((relative) => `${packageRootName}/${relative}`),
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
    manifestSha256: await digestFile(
      path.join(outputRoot, "Mish.app", internalTunAlphaManifestRelativePath),
    ),
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
    const application = await applicationRootFromPackageRoot(root);
    console.log(
      JSON.stringify({
        manifestSha256: await digestFile(
          path.join(application, internalTunAlphaManifestRelativePath),
        ),
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
