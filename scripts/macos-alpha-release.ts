import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(
  process.env.MISH_RELEASE_REPOSITORY_ROOT ?? path.resolve(import.meta.dirname, ".."),
);
const apiVersion = "2026-03-10";
const architecture = "arm64";
const signingMode = "ad-hoc";
const expectedGatekeeperBoundary = "rejection-or-app-scoped-open-anyway";
const semverPrerelease =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const fullSha = /^[0-9a-f]{40}$/u;
const pinnedMihomoVersion = /^v\d+\.\d+\.\d+$/u;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const safeGitRef = /^(?:HEAD|[A-Za-z0-9][A-Za-z0-9._/-]*)$/u;

export type ReleaseMetadata = {
  architecture: typeof architecture;
  expectedGatekeeperBoundary: typeof expectedGatekeeperBoundary;
  minimumMacosVersion: string;
  mihomoVersion: string;
  releaseKind: "draft-prerelease";
  schemaVersion: 1;
  signingMode: typeof signingMode;
  sourceSha: string;
  tag: string;
  version: string;
};

export type LocalReleaseAsset = {
  content: Buffer;
  contentType: string;
  digest: string;
  name: string;
  path: string;
  size: number;
};

export type RemoteReleaseAsset = {
  digest: string | null;
  id: number;
  name: string;
  size: number;
  state: string;
};

export type RemoteRelease = {
  assets: RemoteReleaseAsset[];
  draft: boolean;
  htmlUrl: string;
  id: number;
  name: string;
  prerelease: boolean;
  tagName: string;
  targetCommitish: string;
  uploadUrl: string;
};

export type RemoteReleaseState = {
  release: RemoteRelease | null;
  tagCommit: string | null;
};

export type StagingPlan = {
  action: "already-staged" | "create-release" | "create-tag-and-release" | "resume-release";
  createRelease: boolean;
  createTag: boolean;
  matchingAssets: string[];
  missingAssets: string[];
};

export type ReleaseRequest = {
  assets?: LocalReleaseAsset[];
  sourceSha: string;
  version: string;
};

export type ReleaseClient = {
  createRelease(request: ReleaseRequest): Promise<void>;
  createTag(tag: string, sourceSha: string): Promise<void>;
  getState(request: ReleaseRequest): Promise<RemoteReleaseState>;
  uploadAsset(release: RemoteRelease, asset: LocalReleaseAsset): Promise<void>;
};

type ParsedVersion = {
  baseVersion: string;
  tag: string;
  version: string;
};

type GitSourceResolution = ParsedVersion & {
  artifactName: string;
  mainSha: string;
  sourceSha: string;
};

type GitHubReleaseResponse = {
  assets?: Array<{
    digest?: string | null;
    id?: number;
    name?: string;
    size?: number;
    state?: string;
  }>;
  draft?: boolean;
  html_url?: string;
  id?: number;
  name?: string;
  prerelease?: boolean;
  tag_name?: string;
  target_commitish?: string;
  upload_url?: string;
};

type GitHubRefResponse = {
  object?: {
    sha?: string;
    type?: string;
  };
};

type GitHubTagResponse = {
  object?: {
    sha?: string;
    type?: string;
  };
};

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Read the Mihomo pin from the selected source tree, not the release tooling commit. */
export function readPinnedMihomoVersion(root = repositoryRoot): string {
  const prepareSource = readFileSync(path.join(root, "scripts/prepare-mihomo.ts"), "utf8");
  const version = /^\s*version:\s*"(v\d+\.\d+\.\d+)"\s*,?\s*$/mu.exec(prepareSource)?.[1];
  invariant(
    version && pinnedMihomoVersion.test(version),
    "Could not read pinned Mihomo version from scripts/prepare-mihomo.ts.",
  );
  const bundleSource = readFileSync(path.join(root, "scripts/build-macos-bundle.ts"), "utf8");
  invariant(
    bundleSource.includes(`.scratch/mihomo/${version}/`),
    `scripts/build-macos-bundle.ts does not use pinned Mihomo ${version}.`,
  );
  return version;
}

function expectedReleaseName(tag: string): string {
  return `Mish ${tag} Alpha`;
}

export function parsePrereleaseVersion(input: string): ParsedVersion {
  invariant(input === input.trim(), "Release version must not contain surrounding whitespace.");
  const match = semverPrerelease.exec(input);
  invariant(match, "Release version must be a canonical prerelease SemVer such as 0.1.0-alpha.1.");
  const baseVersion = `${match[1]}.${match[2]}.${match[3]}`;
  return { baseVersion, tag: `v${input}`, version: input };
}

export function validateReleaseVersion(version: string, desktopVersion: string): ParsedVersion {
  const parsed = parsePrereleaseVersion(version);
  invariant(
    desktopVersion === parsed.baseVersion,
    `Release ${version} does not match desktop application version ${desktopVersion}.`,
  );
  return parsed;
}

function parseJsonVersion(source: string, label: string): string {
  const value = JSON.parse(source) as { version?: unknown };
  invariant(typeof value.version === "string", `${label} does not declare a string version.`);
  return value.version;
}

function parseCargoWorkspaceVersion(source: string): string {
  const workspacePackage = /\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/u.exec(source)?.[1];
  invariant(workspacePackage, "Cargo.toml is missing [workspace.package].");
  const version = /^\s*version\s*=\s*"([^"]+)"\s*$/mu.exec(workspacePackage)?.[1];
  invariant(version, "Cargo.toml workspace package is missing its version.");
  return version;
}

function gitOutput(arguments_: string[], cwd = repositoryRoot): string {
  return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

function gitFile(sourceSha: string, relativePath: string, cwd: string): string {
  return gitOutput(["show", `${sourceSha}:${relativePath}`], cwd);
}

export function readDesktopVersionAt(sourceSha: string, cwd = repositoryRoot): string {
  invariant(
    fullSha.test(sourceSha),
    "Desktop version lookup requires one full lowercase commit SHA.",
  );
  const rootPackageSource = gitFile(sourceSha, "package.json", cwd);
  const rootPackage = JSON.parse(rootPackageSource) as {
    scripts?: Record<string, unknown>;
  };
  invariant(
    rootPackage.scripts?.["desktop:bundle:macos"] ===
      "node scripts/build-macos-bundle.ts --profile alpha-ad-hoc",
    "Selected source does not preserve the #168 desktop:bundle:macos Alpha DMG contract.",
  );
  const versions = new Map<string, string>([
    ["package.json", parseJsonVersion(rootPackageSource, "package.json")],
    [
      "apps/desktop/package.json",
      parseJsonVersion(
        gitFile(sourceSha, "apps/desktop/package.json", cwd),
        "apps/desktop/package.json",
      ),
    ],
    [
      "apps/desktop/src-tauri/tauri.conf.json",
      parseJsonVersion(
        gitFile(sourceSha, "apps/desktop/src-tauri/tauri.conf.json", cwd),
        "apps/desktop/src-tauri/tauri.conf.json",
      ),
    ],
    ["Cargo.toml", parseCargoWorkspaceVersion(gitFile(sourceSha, "Cargo.toml", cwd))],
  ]);
  const distinctVersions = new Set(versions.values());
  invariant(
    distinctVersions.size === 1,
    `Desktop version declarations disagree: ${[...versions].map(([file, value]) => `${file}=${value}`).join(", ")}.`,
  );
  return versions.values().next().value as string;
}

export function resolveGitSource(options: {
  cwd?: string;
  mainRef: string;
  requestedSource?: string;
  version: string;
}): GitSourceResolution {
  const cwd = options.cwd ? path.resolve(options.cwd) : repositoryRoot;
  invariant(
    safeGitRef.test(options.mainRef) &&
      !options.mainRef.includes("..") &&
      !options.mainRef.includes("@{"),
    "Main ref contains unsupported characters.",
  );
  const mainSha = gitOutput(["rev-parse", "--verify", `${options.mainRef}^{commit}`], cwd);
  invariant(fullSha.test(mainSha), `Main ref did not resolve to one full commit SHA: ${mainSha}`);
  const sourceSha = options.requestedSource || mainSha;
  invariant(
    fullSha.test(sourceSha),
    "Optional source SHA must be one full lowercase 40-character commit SHA.",
  );
  const resolvedSource = gitOutput(["rev-parse", "--verify", `${sourceSha}^{commit}`], cwd);
  invariant(
    resolvedSource === sourceSha,
    "Requested source SHA does not identify the exact commit.",
  );
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sourceSha, mainSha], {
    cwd,
    encoding: "utf8",
  });
  invariant(
    ancestry.status === 0,
    ancestry.status === 1
      ? `Requested source ${sourceSha} is not reachable from main ${mainSha}.`
      : `Could not validate source reachability: ${ancestry.stderr.trim()}`,
  );
  const parsed = validateReleaseVersion(options.version, readDesktopVersionAt(sourceSha, cwd));
  return {
    ...parsed,
    artifactName: `Mish-${parsed.version}-arm64.dmg`,
    mainSha,
    sourceSha,
  };
}

export function releaseAssetNames(version: string): string[] {
  parsePrereleaseVersion(version);
  return [`Mish-${version}-arm64.dmg`, "release-metadata.json", "SHA256SUMS.txt"];
}

function assertMetadata(
  metadata: ReleaseMetadata,
  request: Pick<ReleaseRequest, "sourceSha" | "version">,
): void {
  const parsed = parsePrereleaseVersion(request.version);
  invariant(metadata.schemaVersion === 1, "Release metadata has an unsupported schema version.");
  invariant(metadata.version === request.version, "Release metadata version does not match.");
  invariant(metadata.tag === parsed.tag, "Release metadata tag does not match.");
  invariant(
    metadata.sourceSha === request.sourceSha,
    "Release metadata source SHA does not match.",
  );
  invariant(metadata.architecture === architecture, "Release metadata architecture must be arm64.");
  invariant(
    metadata.minimumMacosVersion === readMinimumMacosVersion(),
    "Release metadata minimum macOS version does not match the application configuration.",
  );
  invariant(
    metadata.mihomoVersion === readPinnedMihomoVersion(),
    "Release metadata Mihomo version is wrong.",
  );
  invariant(metadata.signingMode === signingMode, "Release metadata signing mode must be ad-hoc.");
  invariant(
    metadata.expectedGatekeeperBoundary === expectedGatekeeperBoundary,
    "Release metadata Gatekeeper boundary is wrong.",
  );
  invariant(metadata.releaseKind === "draft-prerelease", "Release metadata kind is wrong.");
}

function readMinimumMacosVersion(): string {
  const configuration = JSON.parse(
    readFileSync(path.join(repositoryRoot, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  ) as { bundle?: { macOS?: { minimumSystemVersion?: unknown } } };
  const value = configuration.bundle?.macOS?.minimumSystemVersion;
  invariant(
    typeof value === "string" && /^\d+\.\d+$/u.test(value),
    "Invalid minimum macOS version.",
  );
  return value;
}

function releaseMetadata(request: Pick<ReleaseRequest, "sourceSha" | "version">): ReleaseMetadata {
  const parsed = parsePrereleaseVersion(request.version);
  invariant(
    fullSha.test(request.sourceSha),
    "Release metadata requires one full source commit SHA.",
  );
  return {
    architecture,
    expectedGatekeeperBoundary,
    minimumMacosVersion: readMinimumMacosVersion(),
    mihomoVersion: readPinnedMihomoVersion(),
    releaseKind: "draft-prerelease",
    schemaVersion: 1,
    signingMode,
    sourceSha: request.sourceSha,
    tag: parsed.tag,
    version: parsed.version,
  };
}

function contentType(name: string): string {
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".json")) return "application/json";
  return "text/plain";
}

export function prepareReleaseArtifacts(options: {
  dmgPath: string;
  outputDirectory: string;
  sourceSha: string;
  version: string;
}): LocalReleaseAsset[] {
  const parsed = parsePrereleaseVersion(options.version);
  invariant(
    fullSha.test(options.sourceSha),
    "Artifact generation requires one full source commit SHA.",
  );
  const dmgPath = path.resolve(options.dmgPath);
  const outputDirectory = path.resolve(options.outputDirectory);
  invariant(existsSync(dmgPath) && statSync(dmgPath).isFile(), `Alpha DMG is missing: ${dmgPath}`);
  mkdirSync(outputDirectory, { recursive: true });
  invariant(
    readdirSync(outputDirectory).length === 0,
    `Release artifact directory must be empty: ${outputDirectory}`,
  );

  const dmgName = `Mish-${parsed.version}-arm64.dmg`;
  const destinationDmg = path.join(outputDirectory, dmgName);
  copyFileSync(dmgPath, destinationDmg);
  invariant(statSync(destinationDmg).size > 0, "Versioned Alpha DMG is empty.");

  const metadata = releaseMetadata({
    sourceSha: options.sourceSha,
    version: parsed.version,
  });
  const metadataName = "release-metadata.json";
  const metadataPath = path.join(outputDirectory, metadataName);
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });

  const checksums = [
    `${sha256(readFileSync(destinationDmg))}  ${dmgName}`,
    `${sha256(readFileSync(metadataPath))}  ${metadataName}`,
  ];
  writeFileSync(path.join(outputDirectory, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return readLocalReleaseAssets(outputDirectory, {
    sourceSha: options.sourceSha,
    version: parsed.version,
  });
}

function parseChecksumManifest(source: string): Map<string, string> {
  invariant(source.endsWith("\n"), "SHA256SUMS.txt must end with one newline.");
  const entries = new Map<string, string>();
  for (const line of source.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9.+-]+)$/u.exec(line);
    invariant(match, `Invalid SHA256SUMS.txt entry: ${line}`);
    invariant(!entries.has(match[2]), `Duplicate checksum entry: ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function readLocalReleaseAssets(
  directory: string,
  request: Pick<ReleaseRequest, "sourceSha" | "version">,
): LocalReleaseAsset[] {
  invariant(fullSha.test(request.sourceSha), "Artifact verification requires one full source SHA.");
  const absoluteDirectory = path.resolve(directory);
  const expectedNames = releaseAssetNames(request.version);
  const actualNames = readdirSync(absoluteDirectory).sort();
  invariant(
    JSON.stringify(actualNames) === JSON.stringify([...expectedNames].sort()),
    `Release artifact set is wrong: ${actualNames.join(", ")}`,
  );
  const metadata = JSON.parse(
    readFileSync(path.join(absoluteDirectory, "release-metadata.json"), "utf8"),
  ) as ReleaseMetadata;
  assertMetadata(metadata, request);

  const checksums = parseChecksumManifest(
    readFileSync(path.join(absoluteDirectory, "SHA256SUMS.txt"), "utf8"),
  );
  const checksumTargets = expectedNames.filter((name) => name !== "SHA256SUMS.txt");
  invariant(
    JSON.stringify([...checksums.keys()].sort()) === JSON.stringify(checksumTargets.sort()),
    "SHA256SUMS.txt must cover exactly the DMG and release metadata.",
  );
  for (const [name, digest] of checksums) {
    invariant(
      sha256(readFileSync(path.join(absoluteDirectory, name))) === digest,
      `Checksum mismatch for ${name}.`,
    );
  }

  return expectedNames.map((name) => {
    const assetPath = path.join(absoluteDirectory, name);
    const content = readFileSync(assetPath);
    invariant(content.length > 0, `Release asset is empty: ${name}`);
    return {
      content,
      contentType: contentType(name),
      digest: sha256(content),
      name,
      path: assetPath,
      size: content.length,
    };
  });
}

export function planStaging(request: ReleaseRequest, state: RemoteReleaseState): StagingPlan {
  const parsed = parsePrereleaseVersion(request.version);
  invariant(fullSha.test(request.sourceSha), "Staging requires one full source commit SHA.");
  const expectedNames = releaseAssetNames(request.version);
  const localAssets = new Map((request.assets ?? []).map((asset) => [asset.name, asset]));
  invariant(
    localAssets.size === (request.assets?.length ?? 0),
    "Local release assets contain duplicate names.",
  );
  for (const name of localAssets.keys()) {
    invariant(expectedNames.includes(name), `Unexpected local release asset: ${name}`);
  }

  if (state.tagCommit !== null) {
    invariant(
      state.tagCommit === request.sourceSha,
      `Tag ${parsed.tag} already points to ${state.tagCommit}, not ${request.sourceSha}.`,
    );
  }
  invariant(
    !(state.release && state.tagCommit === null),
    `Release ${parsed.tag} exists without its immutable tag.`,
  );

  if (!state.release) {
    return {
      action: state.tagCommit ? "create-release" : "create-tag-and-release",
      createRelease: true,
      createTag: state.tagCommit === null,
      matchingAssets: [],
      missingAssets: expectedNames,
    };
  }

  const release = state.release;
  invariant(
    release.tagName === parsed.tag,
    `Existing release has unexpected tag ${release.tagName}.`,
  );
  invariant(
    fullSha.test(release.targetCommitish),
    `Existing release target_commitish ${release.targetCommitish} is not a full commit SHA; resolve it before planning.`,
  );
  invariant(
    release.targetCommitish === request.sourceSha,
    `Existing release targets ${release.targetCommitish}, not ${request.sourceSha}.`,
  );
  invariant(release.name === expectedReleaseName(parsed.tag), "Existing release name conflicts.");
  invariant(release.draft, `Existing release ${parsed.tag} is not a Draft.`);
  invariant(release.prerelease, `Existing release ${parsed.tag} is not a Pre-release.`);

  const seen = new Set<string>();
  const matchingAssets: string[] = [];
  for (const asset of release.assets) {
    invariant(!seen.has(asset.name), `Existing release has duplicate asset ${asset.name}.`);
    seen.add(asset.name);
    invariant(
      expectedNames.includes(asset.name),
      `Existing release has unexpected asset ${asset.name}.`,
    );
    invariant(asset.state === "uploaded", `Existing release asset ${asset.name} is not uploaded.`);
    const local = localAssets.get(asset.name);
    if (local) {
      invariant(
        asset.size === local.size,
        `Existing release asset ${asset.name} has the wrong size.`,
      );
      invariant(
        asset.digest != null,
        `Existing release asset ${asset.name} is missing a SHA-256 digest; refuse to resume without digest verification.`,
      );
      invariant(
        asset.digest === `sha256:${local.digest}`,
        `Existing release asset ${asset.name} has a different SHA-256 digest.`,
      );
      matchingAssets.push(asset.name);
    }
  }
  const missingAssets = expectedNames.filter((name) => !seen.has(name));
  return {
    action: missingAssets.length === 0 ? "already-staged" : "resume-release",
    createRelease: false,
    createTag: false,
    matchingAssets,
    missingAssets,
  };
}

class GitHubReleaseClient implements ReleaseClient {
  private readonly repository: string;
  private readonly token: string;

  constructor(repository: string, token: string) {
    invariant(repositoryName.test(repository), "GitHub repository must use owner/name.");
    invariant(token.length > 0, "GH_TOKEN is required for GitHub release state.");
    this.repository = repository;
    this.token = token;
  }

  private async request<T>(
    url: string,
    options: { body?: BodyInit; contentType?: string; method?: string } = {},
  ): Promise<T> {
    const response = await fetch(
      url.startsWith("https://") ? url : `https://api.github.com${url}`,
      {
        body: options.body,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": options.contentType ?? "application/json",
          "X-GitHub-Api-Version": apiVersion,
        },
        method: options.method ?? "GET",
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new GitHubApiError(
        `GitHub API ${response.status} for ${options.method ?? "GET"} ${url}: ${detail.slice(0, 500)}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  private async optional<T>(url: string): Promise<T | null> {
    try {
      return await this.request<T>(url);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async resolveTagObject(type: string, sha: string): Promise<string> {
    let currentType = type;
    let currentSha = sha;
    for (let depth = 0; depth < 8; depth += 1) {
      if (currentType === "commit") {
        invariant(fullSha.test(currentSha), "GitHub tag resolved to an invalid commit SHA.");
        return currentSha;
      }
      invariant(
        currentType === "tag",
        `GitHub tag points to unsupported object type ${currentType}.`,
      );
      const tag = await this.request<GitHubTagResponse>(
        `/repos/${this.repository}/git/tags/${currentSha}`,
      );
      invariant(tag.object?.type && tag.object.sha, "GitHub annotated tag response is incomplete.");
      currentType = tag.object.type;
      currentSha = tag.object.sha;
    }
    throw new Error("GitHub annotated tag chain is too deep.");
  }

  private async releaseByTag(tag: string): Promise<RemoteRelease | null> {
    const matches: RemoteRelease[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const responses = await this.request<GitHubReleaseResponse[]>(
        `/repos/${this.repository}/releases?per_page=100&page=${page}`,
      );
      for (const response of responses) {
        if (response.tag_name === tag) matches.push(normalizeRelease(response));
      }
      if (responses.length < 100) {
        invariant(matches.length <= 1, `GitHub has multiple releases for tag ${tag}.`);
        return matches[0] ?? null;
      }
    }
    throw new Error("GitHub release listing exceeded the fail-closed pagination limit.");
  }

  private async resolveCommitish(commitish: string): Promise<string> {
    if (fullSha.test(commitish)) return commitish;
    const response = await this.request<{ sha?: string }>(
      `/repos/${this.repository}/commits/${encodeURIComponent(commitish)}`,
    );
    invariant(
      typeof response.sha === "string" && fullSha.test(response.sha),
      `GitHub did not resolve target_commitish ${commitish} to a full commit SHA.`,
    );
    return response.sha;
  }

  async getState(request: ReleaseRequest): Promise<RemoteReleaseState> {
    const parsed = parsePrereleaseVersion(request.version);
    const reference = await this.optional<GitHubRefResponse>(
      `/repos/${this.repository}/git/ref/tags/${encodeURIComponent(parsed.tag)}`,
    );
    const tagCommit = reference
      ? await this.resolveTagObject(reference.object?.type ?? "", reference.object?.sha ?? "")
      : null;
    const release = await this.releaseByTag(parsed.tag);
    if (!release) return { release: null, tagCommit };
    const targetCommitish = await this.resolveCommitish(release.targetCommitish);
    return {
      release: { ...release, targetCommitish },
      tagCommit,
    };
  }

  async createTag(tag: string, sourceSha: string): Promise<void> {
    await this.request(`/repos/${this.repository}/git/refs`, {
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: sourceSha }),
      method: "POST",
    });
  }

  async createRelease(request: ReleaseRequest): Promise<void> {
    const parsed = parsePrereleaseVersion(request.version);
    await this.request(`/repos/${this.repository}/releases`, {
      body: JSON.stringify({
        draft: true,
        generate_release_notes: false,
        name: expectedReleaseName(parsed.tag),
        prerelease: true,
        tag_name: parsed.tag,
        target_commitish: request.sourceSha,
      }),
      method: "POST",
    });
  }

  async uploadAsset(release: RemoteRelease, asset: LocalReleaseAsset): Promise<void> {
    const uploadUrl = new URL(release.uploadUrl.replace(/\{\?name,label\}$/u, ""));
    uploadUrl.searchParams.set("name", asset.name);
    await this.request(uploadUrl.toString(), {
      body: asset.content,
      contentType: asset.contentType,
      method: "POST",
    });
  }
}

function normalizeRelease(response: GitHubReleaseResponse): RemoteRelease {
  invariant(
    typeof response.id === "number" &&
      typeof response.tag_name === "string" &&
      typeof response.target_commitish === "string" &&
      typeof response.name === "string" &&
      typeof response.draft === "boolean" &&
      typeof response.prerelease === "boolean" &&
      typeof response.upload_url === "string" &&
      typeof response.html_url === "string",
    "GitHub release response is incomplete.",
  );
  return {
    assets: (response.assets ?? []).map((asset) => {
      invariant(
        typeof asset.id === "number" &&
          typeof asset.name === "string" &&
          typeof asset.size === "number" &&
          typeof asset.state === "string",
        "GitHub release asset response is incomplete.",
      );
      return {
        digest: asset.digest ?? null,
        id: asset.id,
        name: asset.name,
        size: asset.size,
        state: asset.state,
      };
    }),
    draft: response.draft,
    htmlUrl: response.html_url,
    id: response.id,
    name: response.name,
    prerelease: response.prerelease,
    tagName: response.tag_name,
    targetCommitish: response.target_commitish,
    uploadUrl: response.upload_url,
  };
}

/** Treat only known create races as conflicts; rethrow other 422 validation failures. */
export function isGitHubConflict(error: unknown): boolean {
  if (!(error instanceof GitHubApiError)) return false;
  if (error.status === 409) return true;
  if (error.status !== 422) return false;
  return /already_exists|Reference already exists|name already exists/iu.test(error.message);
}

export async function stageVerifiedRelease(
  client: ReleaseClient,
  request: ReleaseRequest,
  dryRun: boolean,
): Promise<{ plan: StagingPlan; state: RemoteReleaseState }> {
  invariant(request.assets, "Staging requires verified local release assets.");
  let state = await client.getState(request);
  let plan = planStaging(request, state);
  if (dryRun) return { plan, state };

  if (plan.createTag) {
    const tag = parsePrereleaseVersion(request.version).tag;
    try {
      await client.createTag(tag, request.sourceSha);
    } catch (error) {
      if (!isGitHubConflict(error)) throw error;
    }
    state = await client.getState(request);
    plan = planStaging(request, state);
    invariant(
      state.tagCommit === request.sourceSha,
      "Tag creation did not freeze the source commit.",
    );
  }

  if (plan.createRelease) {
    try {
      await client.createRelease(request);
    } catch (error) {
      if (!isGitHubConflict(error)) throw error;
    }
    state = await client.getState(request);
    plan = planStaging(request, state);
    invariant(state.release, "Draft Pre-release creation was not observable.");
  }

  invariant(state.release, "Cannot upload release assets before the Draft Pre-release exists.");
  for (const name of plan.missingAssets) {
    const asset = request.assets.find((candidate) => candidate.name === name);
    invariant(asset, `Verified local release asset is missing: ${name}`);
    try {
      await client.uploadAsset(state.release, asset);
    } catch (error) {
      if (!isGitHubConflict(error)) throw error;
    }
    state = await client.getState(request);
    plan = planStaging(request, state);
  }

  state = await client.getState(request);
  plan = planStaging(request, state);
  invariant(plan.action === "already-staged", "Draft Pre-release staging is incomplete.");
  return { plan, state };
}

export function runDeterministicFixture(): Record<string, string> {
  const sourceSha = "1".repeat(40);
  const version = "0.1.0-alpha.1";
  const request = { sourceSha, version };
  const tag = `v${version}`;
  const release = {
    assets: [],
    draft: true,
    htmlUrl: "https://example.invalid/draft",
    id: 1,
    name: expectedReleaseName(tag),
    prerelease: true,
    tagName: tag,
    targetCommitish: sourceSha,
    uploadUrl: "https://uploads.example.invalid{?name,label}",
  };
  const fixture: Record<string, string> = {
    clean: planStaging(request, { release: null, tagCommit: null }).action,
    "same-tag": planStaging(request, { release: null, tagCommit: sourceSha }).action,
    "same-draft": planStaging(request, { release, tagCommit: sourceSha }).action,
  };
  for (const [name, state] of [
    ["conflicting-tag", { release: null, tagCommit: "2".repeat(40) }],
    ["published-release", { release: { ...release, draft: false }, tagCommit: sourceSha }],
  ] as const) {
    try {
      planStaging(request, state);
      throw new Error(`${name} fixture unexpectedly passed.`);
    } catch (error) {
      fixture[name] = error instanceof Error ? error.message : String(error);
    }
  }
  return fixture;
}

function option(arguments_: string[], name: string, required = true): string | undefined {
  const index = arguments_.indexOf(name);
  if (index === -1) {
    invariant(!required, `Missing required option ${name}.`);
    return undefined;
  }
  const value = arguments_[index + 1];
  invariant(value && !value.startsWith("--"), `Option ${name} requires a value.`);
  return value;
}

function appendOutput(values: Record<string, string | number>): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const lines = Object.entries(values).map(([name, value]) => {
    const text = String(value);
    invariant(!text.includes("\n") && !text.includes("\r"), `Output ${name} contains a newline.`);
    return `${name}=${text}`;
  });
  writeFileSync(output, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "resolve") {
    const resolution = resolveGitSource({
      mainRef: option(arguments_, "--main-ref") as string,
      requestedSource: option(arguments_, "--source", false),
      version: option(arguments_, "--version") as string,
    });
    appendOutput({
      artifact_name: resolution.artifactName,
      base_version: resolution.baseVersion,
      main_sha: resolution.mainSha,
      source_sha: resolution.sourceSha,
      tag: resolution.tag,
      version: resolution.version,
    });
    console.log(JSON.stringify(resolution, null, 2));
    return;
  }
  if (command === "prepare-artifacts") {
    const assets = prepareReleaseArtifacts({
      dmgPath: option(arguments_, "--dmg") as string,
      outputDirectory: option(arguments_, "--output-directory") as string,
      sourceSha: option(arguments_, "--source-sha") as string,
      version: option(arguments_, "--version") as string,
    });
    console.log(
      JSON.stringify(
        assets.map(({ digest, name, size }) => ({ digest, name, size })),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "plan" || command === "stage") {
    const repository = option(arguments_, "--repository") as string;
    const sourceSha = option(arguments_, "--source-sha") as string;
    const version = option(arguments_, "--version") as string;
    const artifactDirectory = option(arguments_, "--artifact-directory", command === "stage");
    const assets = artifactDirectory
      ? readLocalReleaseAssets(artifactDirectory, { sourceSha, version })
      : undefined;
    const request = { assets, sourceSha, version };
    const client = new GitHubReleaseClient(repository, process.env.GH_TOKEN ?? "");
    if (command === "plan") {
      const state = await client.getState(request);
      const plan = planStaging(request, state);
      appendOutput({
        action: plan.action,
        missing_assets: plan.missingAssets.join(","),
      });
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    const result = await stageVerifiedRelease(client, request, false);
    invariant(result.state.release, "Staged release is missing.");
    appendOutput({
      action: result.plan.action,
      release_id: result.state.release.id,
      release_url: result.state.release.htmlUrl,
    });
    console.log(
      JSON.stringify(
        {
          action: result.plan.action,
          releaseId: result.state.release.id,
          releaseUrl: result.state.release.htmlUrl,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "fixture") {
    console.log(JSON.stringify(runDeterministicFixture(), null, 2));
    return;
  }
  throw new Error(
    "Usage: macos-alpha-release.ts <resolve|prepare-artifacts|plan|stage|fixture> [options]",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
