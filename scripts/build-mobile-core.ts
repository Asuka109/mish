import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

interface GoArchive {
  filename: string;
  sha256: string;
}

interface ArtifactTarget {
  abi: string;
  goArch: string;
  goAmd64?: string;
  targetTriple: string;
  path: string;
}

interface SourceManifest {
  abiVersion: number;
  wrapperRevision: string;
  mihomo: {
    repository: string;
    version: string;
    commit: string;
    tree: string;
    commitDate: string;
    sourceDateEpoch: number;
    license: string;
    correspondingSource: string;
  };
  go: { version: string; archives: Record<string, GoArchive> };
  android: {
    ndkVersion: string;
    minimumApi: number;
    buildTags: string[];
    artifacts: ArtifactTarget[];
  };
}

interface GoModule {
  Path: string;
  Version?: string;
  Sum?: string;
  Main?: boolean;
  Replace?: GoModule;
}

interface ArtifactEvidence extends ArtifactTarget {
  exportedSymbols: string[];
  machine: string;
  sha256: string;
  size: number;
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repositoryRoot, "mobile-core/source-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SourceManifest;
const expectedSymbols = [
  "mish_core_abi_version_v1",
  "mish_core_close_connection_v1",
  "mish_core_command_v1",
  "mish_core_free_buffer_v1",
  "mish_core_initialize_v1",
  "mish_core_load_config_v1",
  "mish_core_poll_events_v1",
  "mish_core_snapshot_v1",
  "mish_core_start_v1",
  "mish_core_stop_v1",
  "mish_core_validate_config_v1",
  "mish_core_version_v1",
].sort();

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {},
): string {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  }) as string;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

function wrapperDigest(): string {
  const roots = [
    path.join(repositoryRoot, "mobile-core/abi"),
    path.join(repositoryRoot, "mobile-core/wrapper"),
  ];
  const hash = createHash("sha256");
  for (const file of roots.flatMap(listFiles).filter((file) => !file.endsWith("_test.go"))) {
    const relative = path.relative(repositoryRoot, file).split(path.sep).join("/");
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function hostKey(): string {
  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "";
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "";
  if (!platform || !architecture)
    throw new Error(`unsupported Go host ${process.platform}-${process.arch}`);
  return `${platform}-${architecture}`;
}

async function ensureGo(scratchRoot: string): Promise<string> {
  const explicitRoot = process.env.MISH_GO_ROOT;
  if (explicitRoot) {
    const binary = path.join(explicitRoot, "bin/go");
    verifyGo(binary);
    return binary;
  }
  const archive = manifest.go.archives[hostKey()];
  if (!archive) throw new Error(`no pinned Go archive for ${hostKey()}`);
  const toolchainRoot = path.join(scratchRoot, "toolchains", manifest.go.version);
  const binary = path.join(toolchainRoot, "go/bin/go");
  if (existsSync(binary)) {
    verifyGo(binary);
    return binary;
  }
  mkdirSync(toolchainRoot, { recursive: true });
  const archivePath = path.join(toolchainRoot, archive.filename);
  if (!existsSync(archivePath)) {
    const response = await fetch(`https://go.dev/dl/${archive.filename}`);
    if (!response.ok) throw new Error(`Go download failed with HTTP ${response.status}`);
    writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  }
  const digest = sha256File(archivePath);
  if (digest !== archive.sha256) throw new Error(`Go archive checksum mismatch: ${digest}`);
  run("tar", ["-xzf", archivePath, "-C", toolchainRoot]);
  verifyGo(binary);
  return binary;
}

function verifyGo(binary: string): void {
  const version = run(binary, ["version"], { quiet: true }).trim();
  if (!version.includes(`go version ${manifest.go.version} `)) {
    throw new Error(`expected ${manifest.go.version}, received ${version}`);
  }
}

function resolveNdk(): string {
  const candidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_HOME &&
      path.join(process.env.ANDROID_HOME, "ndk", manifest.android.ndkVersion),
    process.env.ANDROID_SDK_ROOT &&
      path.join(process.env.ANDROID_SDK_ROOT, "ndk", manifest.android.ndkVersion),
    path.join(os.homedir(), "Library/Android/sdk/ndk", manifest.android.ndkVersion),
    path.join(os.homedir(), "Android/Sdk/ndk", manifest.android.ndkVersion),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const ndk = candidates.find((candidate) => existsSync(path.join(candidate, "source.properties")));
  if (!ndk) throw new Error(`Android NDK ${manifest.android.ndkVersion} is not installed`);
  const properties = readFileSync(path.join(ndk, "source.properties"), "utf8");
  const revision = properties.match(/^Pkg\.Revision\s*=\s*(.+)$/mu)?.[1]?.trim();
  if (revision !== manifest.android.ndkVersion) {
    throw new Error(
      `expected NDK ${manifest.android.ndkVersion}, received ${revision ?? "unknown"}`,
    );
  }
  return ndk;
}

function ndkHostDirectory(ndk: string): string {
  const prebuilt = path.join(ndk, "toolchains/llvm/prebuilt");
  const hosts = readdirSync(prebuilt).filter((entry) => !entry.startsWith("."));
  if (hosts.length !== 1)
    throw new Error(`expected one NDK host toolchain, received ${hosts.join(", ")}`);
  return path.join(prebuilt, hosts[0]);
}

function ensureSource(sourceDirectory: string): void {
  if (!existsSync(path.join(sourceDirectory, ".git"))) {
    mkdirSync(path.dirname(sourceDirectory), { recursive: true });
    run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      manifest.mihomo.repository,
      sourceDirectory,
    ]);
    run(
      "git",
      [
        "fetch",
        "--depth=1",
        "origin",
        `refs/tags/${manifest.mihomo.version}:refs/tags/${manifest.mihomo.version}`,
      ],
      { cwd: sourceDirectory },
    );
    run("git", ["checkout", "--detach", manifest.mihomo.commit], { cwd: sourceDirectory });
  }
  const head = run("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory, quiet: true }).trim();
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: sourceDirectory,
    quiet: true,
  }).trim();
  const tag = run("git", ["rev-parse", `refs/tags/${manifest.mihomo.version}^{commit}`], {
    cwd: sourceDirectory,
    quiet: true,
  }).trim();
  if (
    head !== manifest.mihomo.commit ||
    tag !== manifest.mihomo.commit ||
    tree !== manifest.mihomo.tree
  ) {
    throw new Error(`Mihomo checkout does not match the pinned commit/tree/tag relationship`);
  }
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: sourceDirectory,
    quiet: true,
  }).trim();
  if (dirty) throw new Error("Mihomo checkout contains modified tracked files");
}

interface BuildTree {
  moduleRoot: string;
  wrapperRoot: string;
}

function prepareBuildTree(sourceDirectory: string, scratchRoot: string): BuildTree {
  const moduleRoot = path.join(scratchRoot, "source-build", manifest.mihomo.tree);
  const trackedFiles = run("git", ["ls-files", "-z"], {
    cwd: sourceDirectory,
    quiet: true,
  })
    .split("\0")
    .filter(Boolean);
  for (const relative of trackedFiles) {
    const destination = path.join(moduleRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(sourceDirectory, relative), destination);
  }

  const wrapperRoot = path.join(moduleRoot, "mish-mobile-core-wrapper");
  mkdirSync(wrapperRoot, { recursive: true });
  for (const file of ["main.go", "runtime.go"]) {
    copyFileSync(
      path.join(repositoryRoot, "mobile-core/wrapper", file),
      path.join(wrapperRoot, file),
    );
  }
  const abiRoot = path.join(moduleRoot, "abi");
  mkdirSync(abiRoot, { recursive: true });
  copyFileSync(
    path.join(repositoryRoot, "mobile-core/abi/mish_mobile_core.h"),
    path.join(abiRoot, "mish_mobile_core.h"),
  );
  return { moduleRoot, wrapperRoot };
}

function buildEnvironment(
  goBinary: string,
  goArch: string,
  goAmd64: string | undefined,
  compiler: string,
  scratchRoot: string,
): NodeJS.ProcessEnv {
  const goRoot = path.dirname(path.dirname(goBinary));
  return {
    ...process.env,
    CC: compiler,
    CGO_ENABLED: "1",
    GOARCH: goArch,
    GOAMD64: goAmd64,
    GOOS: "android",
    GOCACHE: path.join(scratchRoot, "cache/build"),
    GOMODCACHE: path.join(scratchRoot, "cache/modules"),
    GOTOOLCHAIN: "local",
    GOROOT: goRoot,
    SOURCE_DATE_EPOCH: String(manifest.mihomo.sourceDateEpoch),
  };
}

function inspectArtifact(
  file: string,
  target: ArtifactTarget,
  toolchain: string,
): ArtifactEvidence {
  const readelf = path.join(toolchain, "bin/llvm-readelf");
  const nm = path.join(toolchain, "bin/llvm-nm");
  const header = run(readelf, ["-h", file], { quiet: true });
  const machine = header.match(/^\s*Machine:\s*(.+)$/mu)?.[1]?.trim();
  if (!machine) throw new Error(`could not read ELF machine for ${target.abi}`);
  const symbols = run(nm, ["-D", "--defined-only", file], { quiet: true })
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).at(-1) ?? "")
    .filter((symbol) => expectedSymbols.includes(symbol))
    .sort();
  if (symbols.join("\n") !== expectedSymbols.join("\n")) {
    throw new Error(`${target.abi} ABI symbols differ from the v1 contract`);
  }
  return {
    ...target,
    exportedSymbols: symbols,
    machine,
    sha256: sha256File(file),
    size: statSync(file).size,
  };
}

function buildPass(
  pass: string,
  goBinary: string,
  wrapperRoot: string,
  ndkToolchain: string,
  scratchRoot: string,
): ArtifactEvidence[] {
  const artifacts: ArtifactEvidence[] = [];
  for (const target of manifest.android.artifacts) {
    const output = path.join(scratchRoot, pass, target.path);
    mkdirSync(path.dirname(output), { recursive: true });
    const compiler = `${path.join(ndkToolchain, "bin/clang")} --target=${target.targetTriple}${manifest.android.minimumApi}`;
    const environment = buildEnvironment(
      goBinary,
      target.goArch,
      target.goAmd64,
      compiler,
      scratchRoot,
    );
    run(
      goBinary,
      [
        "build",
        "-mod=readonly",
        "-buildmode=c-shared",
        "-buildvcs=false",
        "-trimpath",
        "-gcflags=github.com/metacubex/mihomo/mish-mobile-core-wrapper=-lang=go1.26",
        `-tags=${manifest.android.buildTags.join(",")}`,
        `-ldflags=-buildid= -s -w -X main.wrapperRevision=${manifest.wrapperRevision} -X main.mihomoVersion=${manifest.mihomo.version} -X main.mihomoCommit=${manifest.mihomo.commit}`,
        "-o",
        output,
        ".",
      ],
      { cwd: wrapperRoot, env: environment },
    );
    artifacts.push(inspectArtifact(output, target, ndkToolchain));
  }
  return artifacts;
}

function parseJSONStream(output: string): GoModule[] {
  const modules: GoModule[] = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < output.length; index++) {
    const character = output[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth++;
    } else if (character === "}") {
      depth--;
      if (depth === 0 && start !== -1)
        modules.push(JSON.parse(output.slice(start, index + 1)) as GoModule);
    }
  }
  return modules;
}

function collectModules(goBinary: string, moduleRoot: string, scratchRoot: string): GoModule[] {
  const environment = {
    ...process.env,
    GOMODCACHE: path.join(scratchRoot, "cache/modules"),
    GOTOOLCHAIN: "local",
    GOROOT: path.dirname(path.dirname(goBinary)),
  };
  const output = run(goBinary, ["list", "-mod=readonly", "-m", "-json", "all"], {
    cwd: moduleRoot,
    env: environment,
    quiet: true,
  });
  const modules = parseJSONStream(output).map((module) =>
    module.Path === "github.com/metacubex/mihomo"
      ? { ...module, Main: false, Version: manifest.mihomo.version }
      : module,
  );
  modules.push({ Path: "github.com/Asuka109/mish/mobile-core/wrapper", Main: true });
  return modules.sort((left, right) => left.Path.localeCompare(right.Path));
}

function spdxIdentifier(value: string): string {
  return `SPDXRef-${value.replace(/[^A-Za-z0-9.-]/gu, "-")}`;
}

function createSBOM(
  modules: GoModule[],
  artifacts: ArtifactEvidence[],
  wrapperSha256: string,
): object {
  const packages = modules.map((module) => {
    const isMihomo = module.Path === "github.com/metacubex/mihomo";
    const version = isMihomo ? manifest.mihomo.version : (module.Version ?? "local");
    return {
      SPDXID: spdxIdentifier(`Package-${module.Path}`),
      name: module.Path,
      versionInfo: version,
      downloadLocation: isMihomo ? manifest.mihomo.correspondingSource : "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: isMihomo ? "GPL-3.0-only" : "NOASSERTION",
      licenseDeclared: isMihomo ? "GPL-3.0-only" : "NOASSERTION",
      copyrightText: "NOASSERTION",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:golang/${module.Path}@${version}`,
        },
      ],
    };
  });
  const files = artifacts.map((artifact) => ({
    SPDXID: spdxIdentifier(`File-${artifact.abi}`),
    fileName: `./${artifact.path}`,
    checksums: [{ algorithm: "SHA256", checksumValue: artifact.sha256 }],
    licenseConcluded: "GPL-3.0-only",
    copyrightText: "NOASSERTION",
  }));
  const mainPackage = spdxIdentifier("Package-github.com-Asuka109-mish-mobile-core-wrapper");
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `mish-mobile-core-${manifest.mihomo.version}-android`,
    documentNamespace: `https://github.com/Asuka109/mish/spdx/mobile-core/${manifest.mihomo.commit}/${wrapperSha256}`,
    creationInfo: {
      created: manifest.mihomo.commitDate,
      creators: ["Tool: Mish mobile Core reproducible build"],
    },
    documentDescribes: files.map((file) => file.SPDXID),
    packages,
    files,
    relationships: modules
      .filter((module) => !module.Main)
      .map((module) => ({
        spdxElementId: mainPackage,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: spdxIdentifier(`Package-${module.Path}`),
      })),
  };
}

function writeEvidence(
  evidenceDirectory: string,
  artifacts: ArtifactEvidence[],
  modules: GoModule[],
  wrapperSha256: string,
  goBinary: string,
): void {
  mkdirSync(evidenceDirectory, { recursive: true });
  const goVersion = run(goBinary, ["version"], { quiet: true }).trim();
  const provenance = {
    schemaVersion: 1,
    abiVersion: manifest.abiVersion,
    source: manifest.mihomo,
    wrapper: { revision: manifest.wrapperRevision, sha256: wrapperSha256 },
    toolchains: {
      go: { version: goVersion, archiveSha256: manifest.go.archives[hostKey()].sha256 },
      androidNdk: { revision: manifest.android.ndkVersion, pathRecorded: false },
    },
    build: {
      minimumApi: manifest.android.minimumApi,
      tags: manifest.android.buildTags,
      flags: [
        "-buildmode=c-shared",
        "-buildvcs=false",
        "-trimpath",
        "-gcflags=github.com/metacubex/mihomo/mish-mobile-core-wrapper=-lang=go1.26",
        "-ldflags=-buildid= -s -w",
      ],
      sourceDateEpoch: manifest.mihomo.sourceDateEpoch,
      cCompiler: "NDK clang with an explicit --target triple and API suffix",
      moduleMode: "wrapper copied into the pinned Mihomo module tree",
    },
    correspondingSource: manifest.mihomo.correspondingSource,
    license: "GPL-3.0-only",
    artifacts,
  };
  writeFileSync(
    path.join(evidenceDirectory, "build-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  writeFileSync(
    path.join(evidenceDirectory, "SHA256SUMS"),
    `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
  );
  writeFileSync(path.join(evidenceDirectory, "abi-symbols.txt"), `${expectedSymbols.join("\n")}\n`);
  writeFileSync(
    path.join(evidenceDirectory, "sbom.spdx.json"),
    `${JSON.stringify(createSBOM(modules, artifacts, wrapperSha256), null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  const scratchRoot = path.resolve(
    argument("--scratch-dir") ?? path.join(repositoryRoot, ".scratch/mobile-core"),
  );
  const sourceDirectory = path.resolve(
    argument("--source-dir") ?? path.join(scratchRoot, "source/mihomo"),
  );
  const evidenceDirectory = path.resolve(
    argument("--evidence-dir") ?? path.join(scratchRoot, "evidence"),
  );
  mkdirSync(scratchRoot, { recursive: true });
  const goBinary = await ensureGo(scratchRoot);
  const ndk = resolveNdk();
  const ndkToolchain = ndkHostDirectory(ndk);
  ensureSource(sourceDirectory);
  const buildTree = prepareBuildTree(sourceDirectory, scratchRoot);
  const first = buildPass("pass-1", goBinary, buildTree.wrapperRoot, ndkToolchain, scratchRoot);
  const second = buildPass("pass-2", goBinary, buildTree.wrapperRoot, ndkToolchain, scratchRoot);
  for (let index = 0; index < first.length; index++) {
    if (first[index].sha256 !== second[index].sha256) {
      throw new Error(`${first[index].abi} is not reproducible across clean output paths`);
    }
  }
  const modules = collectModules(goBinary, buildTree.moduleRoot, scratchRoot);
  writeEvidence(evidenceDirectory, first, modules, wrapperDigest(), goBinary);
  console.log(
    `Built and reproduced ${first.map((artifact) => artifact.abi).join(", ")} from ${manifest.mihomo.commit}.`,
  );
  console.log(`Untracked artifacts: ${path.join(scratchRoot, "pass-1/android")}`);
  console.log(`Evidence: ${evidenceDirectory}`);
}

await main();
