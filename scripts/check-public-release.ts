import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const projectLicense = "GPL-3.0-only";
const canonicalGplV3Sha256 = "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986";
const requiredPublicFiles = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "PRIVACY.md",
  "DISCLAIMER.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "docs/legal/public-release-review.md",
] as const;
const packagedLegalResources = [
  "DISCLAIMER.md",
  "LICENSE",
  "PRIVACY.md",
  "THIRD_PARTY_NOTICES.md",
] as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function json(relativePath: string): Record<string, unknown> {
  return JSON.parse(read(relativePath)) as Record<string, unknown>;
}

function filesUnder(
  relativeDirectory: string,
  accepts: (relativePath: string) => boolean,
): string[] {
  return readdirSync(path.join(root, relativeDirectory), { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return filesUnder(relativePath, accepts);
      return entry.isFile() && accepts(relativePath) ? [relativePath] : [];
    },
  );
}

function includesAll(source: string, values: readonly string[], label: string): void {
  const normalizedSource = source.replace(/^[ \t]*>[ \t]?/gmu, "").replace(/\s+/gu, " ");
  for (const value of values) {
    const normalizedValue = value.replace(/\s+/gu, " ");
    invariant(normalizedSource.includes(normalizedValue), `${label} is missing: ${value}`);
  }
}

for (const file of requiredPublicFiles) {
  invariant(existsSync(path.join(root, file)), `Required public file is missing: ${file}`);
}

const licenseDigest = createHash("sha256")
  .update(readFileSync(path.join(root, "LICENSE")))
  .digest("hex");
invariant(
  licenseDigest === canonicalGplV3Sha256,
  "LICENSE must remain the canonical FSF GPLv3 plain text without reformatting.",
);

const packageManifests = [
  "package.json",
  ...["apps", "packages"].flatMap((directory) =>
    readdirSync(path.join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${directory}/${entry.name}/package.json`)
      .filter((manifest) => existsSync(path.join(root, manifest))),
  ),
];
for (const manifest of packageManifests) {
  const metadata = json(manifest);
  invariant(
    metadata.license === projectLicense,
    `${manifest} must declare ${projectLicense}, received ${String(metadata.license)}.`,
  );
}

const workspaceManifest = read("Cargo.toml");
invariant(
  workspaceManifest.includes(`license = "${projectLicense}"`),
  `Cargo workspace must declare ${projectLicense}.`,
);
const memberMatch = workspaceManifest.match(/members = \[(?<members>[\s\S]*?)\]/u);
invariant(memberMatch?.groups?.members, "Cargo workspace member list is missing.");
const cargoMembers = [...memberMatch.groups.members.matchAll(/"([^"]+)"/gu)].map(
  (match) => match[1],
);
invariant(cargoMembers.length > 0, "Cargo workspace must contain package members.");
for (const member of cargoMembers) {
  invariant(member, "Cargo workspace contains an empty member.");
  const manifest = `${member}/Cargo.toml`;
  invariant(existsSync(path.join(root, manifest)), `Cargo member manifest is missing: ${manifest}`);
  invariant(
    read(manifest).includes("license.workspace = true"),
    `${manifest} must inherit the workspace license.`,
  );
}

function resourceMap(relativePath: string): Record<string, string> {
  const configuration = json(relativePath);
  const bundle = configuration.bundle as Record<string, unknown> | undefined;
  const resources = bundle?.resources;
  invariant(resources && typeof resources === "object", `${relativePath} has no resource map.`);
  return resources as Record<string, string>;
}

for (const configuration of [
  "apps/desktop/src-tauri/tauri.bundle.conf.json",
  "apps/mobile/src-tauri/tauri.conf.json",
]) {
  const resources = resourceMap(configuration);
  for (const legalResource of packagedLegalResources) {
    invariant(
      resources[`../../../${legalResource}`] === legalResource,
      `${configuration} must package ${legalResource} at its stable resource name.`,
    );
  }
}

const bundleVerifier = read("scripts/verify-macos-bundle.ts");
for (const legalResource of packagedLegalResources) {
  invariant(
    bundleVerifier.includes(`"${legalResource}"`),
    `The macOS verifier must check ${legalResource}.`,
  );
}

const notices = read("THIRD_PARTY_NOTICES.md");
includesAll(
  notices,
  [
    "not affiliated with, endorsed by, sponsored",
    "MetaCubeX/mihomo",
    "v1.19.29",
    "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb",
    "GPL-3.0-only",
    "Tauri",
    "React",
    "Base UI",
    "Phosphor Icons",
    "Lucide",
    "Highcharts",
    "Separate Highsoft terms",
    "commercial or OEM license grant",
    "Remix Icon License v1.0",
    "registry.npmmirror.com",
    "Petri R",
    "Unsplash License",
    "NOASSERTION",
  ],
  "THIRD_PARTY_NOTICES.md",
);

const readme = read("README.md");
includesAll(
  readme,
  [
    "neutral, experimental tool for local traffic forwarding, configuration management, and diagnostics",
    "does not have a stable public release",
    "not production distributions",
    "not affiliated with, endorsed by, or an official client",
    "does not operate a hosted proxy or VPN service",
    "a successful run, artifact identity, and digest must be verified before testing",
    "The test package is ad-hoc signed unless release credentials are supplied.",
    "It does not yet establish a TUN interface or capture traffic.",
    "There is no complete shell, Packet Tunnel extension",
    "No supported package or completed native integration",
    "Public distribution remains gated by the active packaging audit",
    "third-party license review",
    "remote service icons can make outbound requests",
  ],
  "README.md",
);

includesAll(
  read("PRODUCT.md"),
  [
    "neutral technical tool for local traffic forwarding, configuration management, and diagnostics",
  ],
  "PRODUCT.md",
);

const positioningFiles = [
  ...readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name),
  ...filesUnder("docs", (relativePath) => relativePath.endsWith(".md")),
  ...filesUnder("apps/web/src", (relativePath) => /\.(?:ts|tsx)$/u.test(relativePath)),
];
const disallowedPositioning = [
  ["circumvention framing", /\bcircumvent(?:ion|ing)?\b/iu],
  ["censorship framing", /\bcensor(?:ship|ed|ing)?\b/iu],
  ["anti-government framing", /\banti-government\b/iu],
  ["government-resistance framing", /\bresist(?:ance|ing)?\s+(?:a\s+)?government\b/iu],
  ["information-freedom framing", /\b(?:information|internet)\s+freedom\b/iu],
  ["information-freedom framing", /\bfreedom\s+of\s+information\b/iu],
  ["firewall-evasion framing", /\bgreat\s+firewall\b|\bgfw\b/iu],
  ["non-neutral Chinese positioning", /翻墙|反抗政府|反政府|信息自由|突破封锁|绕过审查|规避审查/u],
] as const;
for (const relativePath of positioningFiles) {
  const source = read(relativePath);
  for (const [label, pattern] of disallowedPositioning) {
    invariant(!pattern.test(source), `${relativePath} contains disallowed ${label}.`);
  }
}

const privacy = read("PRIVACY.md");
includesAll(
  privacy,
  [
    "not a universal compliance statement",
    "does not configure a Mish account service",
    "service probes",
    "registry.npmmirror.com/remixicon/4.9.1",
  ],
  "PRIVACY.md",
);

const security = read("SECURITY.md");
includesAll(
  security,
  [
    "does not yet have a verified private vulnerability-reporting channel",
    "no stable release or security-support window",
    "No response-time, remediation-time, disclosure-date, warranty, support, or credit commitment",
  ],
  "SECURITY.md",
);

console.log(
  `Public-release checks passed: ${requiredPublicFiles.length} public files, ${packageManifests.length} npm manifests, ${cargoMembers.length} Cargo members, ${packagedLegalResources.length} packaged legal resources.`,
);
