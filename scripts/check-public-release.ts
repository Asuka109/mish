import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const projectLicense = "GPL-3.0-only";
const canonicalGplV3Sha256 = "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986";
const requiredPublicFiles = [
  "README.md",
  "README.zh-CN.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
] as const;
const packagedLegalResources = ["LICENSE", "THIRD_PARTY_NOTICES.md"] as const;

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
for (const policyFile of [
  "SECURITY.md",
  "PRIVACY.md",
  "DISCLAIMER.md",
  "docs/legal/public-release-review.md",
]) {
  invariant(
    !existsSync(path.join(root, policyFile)),
    `${policyFile} must not create a formal policy surface without an explicit maintainer decision.`,
  );
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
  for (const removedPolicyResource of ["SECURITY.md", "PRIVACY.md", "DISCLAIMER.md"]) {
    invariant(
      !Object.values(resources).includes(removedPolicyResource),
      `${configuration} must not package ${removedPolicyResource}.`,
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
for (const removedPolicyResource of ["SECURITY.md", "PRIVACY.md", "DISCLAIMER.md"]) {
  invariant(
    !bundleVerifier.includes(`"${removedPolicyResource}"`),
    `The macOS verifier must not require ${removedPolicyResource}.`,
  );
}

const notices = read("THIRD_PARTY_NOTICES.md");
includesAll(
  notices,
  [
    "not affiliated with, endorsed by, sponsored",
    "MetaCubeX/mihomo",
    "live namespace no longer exposed the Core source and tag state",
    "preserved public mirror solely for source retrieval",
    "not represented as the official project",
    "cyenxchen/mihomo",
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
    "[简体中文](README.zh-CN.md)",
    "Mish is a cross-platform client for local traffic forwarding, configuration, and diagnostics.",
    "neutral, experimental project built around a locally managed",
    "interface is built with React and TypeScript, with Tauri and Rust providing platform integration",
    "does not have a stable public release",
    "not affiliated with, endorsed by, or an official client",
    "does not operate a hosted proxy or VPN service",
    "completed packaging-readiness audit selected a System Proxy-only first public macOS release",
    "lawful, authorized purposes",
    "laws and third-party terms that apply in your location",
    "infringes your rights, contact the project maintainers",
    "macOS (Apple Silicon)",
    "🚧 Limited compatibility",
    "Android",
    "❌ Not currently supported",
    "— Not currently available",
    "macOS 13 or later on Apple Silicon only",
    "There is no stable package download yet.",
    "Virtual Interface support belongs to a separate future release path",
    "remote service icons can make outbound requests",
    "Developer setup, commands, architecture, and validation details are maintained in",
    "does not require copyright assignment or a Contributor License Agreement",
    "confirm authority to contribute the material and license it under GPL-3.0-only",
    "GitHub's inbound=outbound rule",
    "Submission alone transfers no copyright to Mish",
    "ownership remains with the applicable copyright holder",
    "receives no separate proprietary-relicensing permission",
    "AI-assisted submissions require complete human review",
    "architecture and interaction design were inspired by and in part informed by",
    "ClashX",
    "Clash Mi",
    "Stash",
    "Clash Verge",
    "MetaCubeXD",
    "does not imply affiliation, endorsement, or incorporation of their code or assets",
  ],
  "README.md",
);
const readmeOpening = readme.slice(0, readme.indexOf("> [!IMPORTANT]"));
for (const deferredDetail of [
  "Mihomo",
  "neutral",
  "experimental",
  "MetaCubeX",
  "lawful",
  "infringes",
  "legal advice",
]) {
  invariant(
    !readmeOpening.includes(deferredDetail),
    `README.md opening must defer ${deferredDetail} to Security and privacy.`,
  );
}
for (const technicalDetail of [
  "MISH_MIHOMO_BIN",
  "v1.19.29",
  "## Downloads and installation",
  "## Development quick start",
  "## Architecture",
]) {
  invariant(
    !readme.includes(technicalDetail),
    `README.md contains developer detail: ${technicalDetail}`,
  );
}

const chineseReadme = read("README.zh-CN.md");
includesAll(
  chineseReadme,
  [
    "[English](README.md)",
    "用于本地流量转发、配置管理与诊断的跨平台客户端",
    "围绕本地管理的",
    "构建的中立实验性项目",
    "界面使用 React 和 TypeScript 构建，并通过 Tauri 和 Rust 实现平台集成",
    "尚无稳定公开版本",
    "与 MetaCubeX 不存在隶属、背书或官方客户端关系",
    "不运营托管代理或 VPN 服务",
    "已完成的打包就绪审计",
    "合法且已获授权的用途",
    "遵守所在地区适用的法律及第三方条款",
    "侵犯了您的权利，请联系项目维护者",
    "macOS（Apple 芯片）",
    "🚧 有限兼容",
    "❌ 暂不支持",
    "— 暂无可用版本",
    "macOS 13 或更高版本",
    "目前尚无稳定软件包可供下载",
    "“虚拟接口”支持属于独立的后续发行路径，目前不可用",
    "远程服务图标可能发起出站请求",
    "开发环境、命令、架构和验证细节维护在",
    "不要求转让版权或签署贡献者许可协议",
    "确认其有权贡献相关材料",
    "GitHub 的入站许可等于出站许可规则",
    "提交本身不会向 Mish 转让版权",
    "所有权仍属于适用的版权所有者",
    "获得单独的专有再许可权",
    "使用生成式 AI",
    "必须经过完整的人工核查",
    "架构与交互设计受到",
    "ClashX",
    "Clash Mi",
    "Stash",
    "Clash Verge",
    "MetaCubeXD",
    "此处致谢不表示任何隶属、背书",
  ],
  "README.zh-CN.md",
);
const chineseReadmeOpening = chineseReadme.slice(0, chineseReadme.indexOf("> [!IMPORTANT]"));
for (const deferredDetail of [
  "Mihomo",
  "中立",
  "实验性",
  "MetaCubeX",
  "合法",
  "侵犯",
  "法律建议",
]) {
  invariant(
    !chineseReadmeOpening.includes(deferredDetail),
    `README.zh-CN.md opening must defer ${deferredDetail} to 安全与隐私.`,
  );
}
for (const technicalDetail of [
  "MISH_MIHOMO_BIN",
  "v1.19.29",
  "## 下载与安装",
  "## 开发快速开始",
  "## 架构",
]) {
  invariant(
    !chineseReadme.includes(technicalDetail),
    `README.zh-CN.md contains developer detail: ${technicalDetail}`,
  );
}

includesAll(
  read("CONTRIBUTING.md"),
  [
    "confirm that you have authority to contribute the material",
    "license the contribution under GPL-3.0-only",
    "GitHub's Contributions Under Repository License rule",
    "does not require a Contributor License Agreement, copyright assignment, or Developer Certificate of Origin",
    "Submission does not by itself transfer to Mish",
    "Ownership remains with the applicable copyright holder",
    "receives no separate proprietary-relicensing permission",
    "may be sold or otherwise distributed commercially",
    "may relicense another copyright holder's GPL-covered contribution",
    "Mihomo's published generative AI content policy",
    "issue-submission guidance",
    "Complete human review is required",
    "Generated conclusions are not technical evidence",
    "Third-party rights must be documented",
  ],
  "CONTRIBUTING.md",
);

includesAll(
  read("docs/operations/macos-packaging.md"),
  [
    "completed packaging-readiness audit selected a System Proxy-only first public release",
    "does not depend on a production privileged TUN helper",
    "explicit signed no-helper distribution mode",
    "This leaves current CI artifact evidence unavailable; it is not evidence of a product implementation failure",
    "A TUN-enabled distribution remains a separate future path",
    "does not claim that the planned explanatory interaction is implemented",
  ],
  "docs/operations/macos-packaging.md",
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

console.log(
  `Public-release checks passed: ${requiredPublicFiles.length} public files, ${packageManifests.length} npm manifests, ${cargoMembers.length} Cargo members, ${packagedLegalResources.length} packaged legal resources.`,
);
