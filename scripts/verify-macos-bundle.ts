import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const application = path.resolve(
  process.env.MISH_MACOS_APP_PATH ?? "target/release/bundle/macos/Mish.app",
);
const contents = path.join(application, "Contents");
const resources = path.join(contents, "Resources");
const bundledMihomo = path.join(resources, "mihomo-aarch64-apple-darwin");
const preparedMihomo = path.resolve(".scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29");
const bundledWeb = path.join(resources, "web-dist");
const sourceWeb = path.resolve("apps/web/dist");
const legalResources = ["LICENSE", "THIRD_PARTY_NOTICES.md"] as const;

function command(program: string, arguments_: string[]) {
  return execFileSync(program, arguments_, { encoding: "utf8" }).trim();
}

async function sha256(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function files(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return files(root, absolute);
      }
      if (!entry.isFile()) {
        throw new Error(`Unexpected non-file bundle resource: ${absolute}`);
      }
      return [path.relative(root, absolute)];
    }),
  );
  return discovered.flat().sort();
}

const identifier = command("plutil", [
  "-extract",
  "CFBundleIdentifier",
  "raw",
  "-o",
  "-",
  path.join(contents, "Info.plist"),
]);
if (identifier !== "com.asuka109.mish") {
  throw new Error(`Unexpected bundle identifier: ${identifier}`);
}

const executableName = command("plutil", [
  "-extract",
  "CFBundleExecutable",
  "raw",
  "-o",
  "-",
  path.join(contents, "Info.plist"),
]);
const executable = path.join(contents, "MacOS", executableName);
for (const binary of [executable, bundledMihomo]) {
  const description = command("file", [binary]);
  if (!description.includes("Mach-O 64-bit executable arm64")) {
    throw new Error(`Bundle contains a non-ARM64 executable: ${description}`);
  }
  if ((await stat(binary)).mode & 0o111) {
    continue;
  }
  throw new Error(`Bundle executable is not executable: ${binary}`);
}

const mihomoDigest = await sha256(bundledMihomo);
const preparedMihomoDigest = await sha256(preparedMihomo);
if (mihomoDigest !== preparedMihomoDigest) {
  throw new Error(
    `Bundled Mihomo checksum mismatch: expected ${preparedMihomoDigest}, received ${mihomoDigest}`,
  );
}
const mihomoVersion = command(bundledMihomo, ["-v"]);
if (!mihomoVersion.includes("v1.19.29 darwin arm64")) {
  throw new Error(`Unexpected bundled Mihomo version: ${mihomoVersion}`);
}

const sourceWebFiles = await files(sourceWeb);
const bundledWebFiles = await files(bundledWeb);
if (
  sourceWebFiles.length === 0 ||
  JSON.stringify(sourceWebFiles) !== JSON.stringify(bundledWebFiles)
) {
  throw new Error("The bundled offline Web resource set is incomplete");
}
for (const relative of sourceWebFiles) {
  const sourceDigest = await sha256(path.join(sourceWeb, relative));
  const bundledDigest = await sha256(path.join(bundledWeb, relative));
  if (sourceDigest !== bundledDigest) {
    throw new Error(`Bundled Web resource checksum mismatch: ${relative}`);
  }
}
const index = await readFile(path.join(bundledWeb, "index.html"), "utf8");
if (/\b(?:src|href)=["']https?:\/\//iu.test(index)) {
  throw new Error("The bundled Web entry point references a remote asset");
}

for (const legalResource of legalResources) {
  const source = path.resolve(legalResource);
  const bundled = path.join(resources, legalResource);
  if ((await sha256(source)) !== (await sha256(bundled))) {
    throw new Error(`Bundled legal resource does not match the repository: ${legalResource}`);
  }
}
const license = await readFile(path.join(resources, "LICENSE"), "utf8");
if (!license.includes("GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007")) {
  throw new Error("The bundled LICENSE is not the declared GPL version 3 text");
}
const notices = await readFile(path.join(resources, "THIRD_PARTY_NOTICES.md"), "utf8");
for (const requiredNotice of [
  "MetaCubeX/mihomo",
  "v1.19.29",
  "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb",
  "GPL-3.0",
]) {
  if (!notices.includes(requiredNotice)) {
    throw new Error(`The bundled third-party notices omit ${requiredNotice}`);
  }
}

const forbiddenHelperLocations = [
  path.join(contents, "Library", "LaunchDaemons"),
  path.join(contents, "MacOS", "mish-tun-helper"),
];
for (const forbidden of forbiddenHelperLocations) {
  try {
    await stat(forbidden);
    throw new Error(`Unverified TUN helper content was packaged: ${forbidden}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

execFileSync("codesign", ["--verify", "--strict", bundledMihomo], {
  stdio: "inherit",
});
execFileSync("codesign", ["--verify", "--deep", "--strict", application], {
  stdio: "inherit",
});

console.log(
  `Verified ${application}: ${identifier}, ARM64, Mihomo v1.19.29, ${sourceWebFiles.length} offline Web files, GPL notices, no TUN helper`,
);
