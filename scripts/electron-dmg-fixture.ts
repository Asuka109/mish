import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMacOsDmg, verifyMacOsDmgPresentation } from "./macos-dmg-presentation.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const hostRoot = path.join(repositoryRoot, "apps", "desktop-electron");
const hostDist = path.join(hostRoot, "dist");
const webDist = path.join(repositoryRoot, "apps", "web", "dist");
const outputDirectory = path.join(repositoryRoot, "target", "desktop-electron");
const output = path.join(outputDirectory, "Mish-Electron-Foundation-fixture.dmg");

function requireDarwin(): void {
  if (process.platform !== "darwin") {
    throw new Error("Electron DMG fixture packaging requires macOS");
  }
}

function requireDirectory(directory: string, description: string): void {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Electron DMG fixture is missing ${description}: ${directory}`);
  }
}

function writeFixtureInfoPlist(file: string): void {
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Mish Electron Foundation</string>
  <key>CFBundleExecutable</key><string>mish-electron</string>
  <key>CFBundleIdentifier</key><string>com.asuka109.mish.electron.foundation.fixture</string>
  <key>CFBundleName</key><string>Mish Electron Foundation</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0-fixture</string>
  <key>CFBundleVersion</key><string>0.1.0-fixture</string>
</dict>
</plist>
`,
    { mode: 0o644 },
  );
}

function createFixtureBundle(temporary: string): string {
  requireDirectory(hostDist, "built Electron host");
  requireDirectory(webDist, "built production Web renderer");
  const bundle = path.join(temporary, "Mish.app");
  const contents = path.join(bundle, "Contents");
  const resources = path.join(contents, "Resources");
  const executable = path.join(contents, "MacOS", "mish-electron");
  mkdirSync(path.dirname(executable), { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFixtureInfoPlist(path.join(contents, "Info.plist"));
  cpSync(hostDist, path.join(resources, "electron-host"), { recursive: true });
  cpSync(webDist, path.join(resources, "web"), { recursive: true });
  // The fixture executable is an inert, local Mach-O shell copy. It makes the
  // bundle ad-hoc-signable without embedding an Electron binary or any backend.
  cpSync("/bin/sh", executable);
  chmodSync(executable, 0o755);
  execFileSync("/usr/bin/codesign", ["--sign", "-", "--force", "--deep", bundle], {
    stdio: "pipe",
  });
  return bundle;
}

function verifyFixtureBundle(bundle: string): void {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
    stdio: "pipe",
  });
  const info = readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8");
  if (!info.includes("com.asuka109.mish.electron.foundation.fixture")) {
    throw new Error("Electron DMG fixture bundle identifier is invalid");
  }
  for (const required of [
    "Contents/Resources/electron-host/main.js",
    "Contents/Resources/electron-host/preload.js",
    "Contents/Resources/web/index.html",
  ]) {
    requireDirectory(path.dirname(path.join(bundle, required)), required);
    if (!statSync(path.join(bundle, required), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Electron DMG fixture is missing required file: ${required}`);
    }
  }
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function main(): void {
  requireDarwin();
  mkdirSync(outputDirectory, { recursive: true });
  const temporary = mkdtempSync(path.join(tmpdir(), "mish-electron-dmg-fixture-"));
  try {
    const bundle = createFixtureBundle(temporary);
    createMacOsDmg(bundle, output, {
      normalizeForDeterminism: true,
      replaceExistingOutput: true,
    });
    verifyMacOsDmgPresentation(output, verifyFixtureBundle);
    console.log(
      JSON.stringify(
        {
          artifact: path.relative(repositoryRoot, output),
          sha256: sha256(output),
          sizeBytes: statSync(output).size,
          signature: "ad-hoc",
          verification: "read-only DMG structure and Finder template",
        },
        null,
        2,
      ),
    );
  } finally {
    execFileSync("trash", [temporary], { stdio: "ignore" });
  }
}

main();
