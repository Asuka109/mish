import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const presentationFile = path.resolve("resources/macos-dmg/presentation.json");
const presentationDirectory = path.dirname(presentationFile);
const expectedRootEntries = [".DS_Store", ".background", "Applications", "Mish.app"] as const;
const expectedVisibleEntries = ["Applications", "Mish.app"] as const;
const minimumImageMiB = 128;
const imageOverheadMiB = 64;

type Point = {
  x: number;
  y: number;
};

type MacOsDmgPresentation = {
  background: {
    file: string;
    instruction: string;
    sha256: string;
  };
  icons: {
    items: Record<"Applications" | "Mish.app", Point>;
    size: number;
    textSize: number;
  };
  schemaVersion: 1;
  template: {
    dsStoreSha256: string;
    file: string;
    sha256: string;
  };
  volumeName: string;
  window: {
    position: Point;
    size: {
      height: number;
      width: number;
    };
  };
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function isPoint(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return Number.isInteger(point.x) && Number.isInteger(point.y) && Object.keys(point).length === 2;
}

function loadPresentation(): MacOsDmgPresentation {
  const parsed = JSON.parse(
    readFileSync(presentationFile, "utf8"),
  ) as Partial<MacOsDmgPresentation>;
  invariant(
    parsed &&
      parsed.schemaVersion === 1 &&
      parsed.volumeName === "Mish" &&
      parsed.template &&
      typeof parsed.template.file === "string" &&
      /^[a-f0-9]{64}$/u.test(parsed.template.sha256) &&
      /^[a-f0-9]{64}$/u.test(parsed.template.dsStoreSha256) &&
      parsed.background &&
      parsed.background.file === ".background/mish-install.png" &&
      parsed.background.instruction === "Drag Mish to Applications" &&
      /^[a-f0-9]{64}$/u.test(parsed.background.sha256) &&
      parsed.window &&
      isPoint(parsed.window.position) &&
      parsed.window.position.x === 180 &&
      parsed.window.position.y === 160 &&
      parsed.window.size?.width === 720 &&
      parsed.window.size.height === 410 &&
      parsed.icons &&
      parsed.icons.size === 112 &&
      parsed.icons.textSize === 13 &&
      isPoint(parsed.icons.items?.["Mish.app"]) &&
      parsed.icons.items["Mish.app"].x === 180 &&
      parsed.icons.items["Mish.app"].y === 240 &&
      isPoint(parsed.icons.items?.Applications) &&
      parsed.icons.items.Applications.x === 540 &&
      parsed.icons.items.Applications.y === 240,
    "macOS DMG presentation contract is invalid",
  );
  return parsed as MacOsDmgPresentation;
}

function requireDarwin(): void {
  invariant(process.platform === "darwin", "macOS DMG presentation requires macOS");
}

function requireRegularFile(file: string, description: string): void {
  const metadata = lstatSync(file);
  invariant(
    metadata.isFile() && !metadata.isSymbolicLink(),
    `macOS DMG ${description} must be a regular file: ${file}`,
  );
}

function requireDirectory(directory: string, description: string): void {
  const metadata = lstatSync(directory);
  invariant(
    metadata.isDirectory() && !metadata.isSymbolicLink(),
    `macOS DMG ${description} must be a real directory: ${directory}`,
  );
}

function templatePath(presentation: MacOsDmgPresentation): string {
  return path.join(presentationDirectory, presentation.template.file);
}

function verifyTemplateFile(presentation: MacOsDmgPresentation): void {
  const template = templatePath(presentation);
  requireRegularFile(template, "template");
  invariant(
    sha256(template) === presentation.template.sha256,
    "macOS DMG template digest differs from the presentation contract",
  );
}

function assertTemplateRoot(root: string, presentation: MacOsDmgPresentation): void {
  const entries = readdirSync(root).sort();
  invariant(
    JSON.stringify(entries) === JSON.stringify(expectedRootEntries),
    `macOS DMG root contains unexpected entries: ${entries.join(", ")}`,
  );
  const application = path.join(root, "Mish.app");
  const applications = path.join(root, "Applications");
  const background = path.join(root, presentation.background.file);
  const dsStore = path.join(root, ".DS_Store");
  requireDirectory(application, "Mish.app");
  invariant(
    readdirSync(application).length === 0,
    "macOS DMG template Mish.app placeholder must be empty",
  );
  invariant(
    lstatSync(applications).isSymbolicLink() && readlinkSync(applications) === "/Applications",
    "macOS DMG Applications alias must target /Applications",
  );
  requireRegularFile(background, "background");
  requireRegularFile(dsStore, "Finder metadata");
  invariant(
    sha256(background) === presentation.background.sha256,
    "macOS DMG background digest differs from the presentation contract",
  );
  invariant(
    sha256(dsStore) === presentation.template.dsStoreSha256,
    "macOS DMG Finder metadata digest differs from the presentation contract",
  );
}

function outputFromBase(base: string): string {
  const candidate = `${base}.dmg`;
  return existsSync(candidate) ? candidate : base;
}

function imageSizeMiB(application: string): number {
  const kibibytes = Number.parseInt(
    execFileSync("/usr/bin/du", ["-sk", application], { encoding: "utf8" })
      .trim()
      .split(/\s+/u)[0] ?? "",
    10,
  );
  invariant(
    Number.isSafeInteger(kibibytes) && kibibytes > 0,
    "macOS DMG application size is invalid",
  );
  return Math.max(minimumImageMiB, Math.ceil(kibibytes / 1024) + imageOverheadMiB);
}

function detachDiskImage(mountpoint: string): void {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = spawnSync("/usr/bin/hdiutil", ["detach", mountpoint], { encoding: "utf8" });
    if (result.status === 0) return;
    failures.push(String(result.stderr ?? "").trim() || `exit ${String(result.status)}`);
  }
  throw new Error(`Could not cleanly detach macOS DMG after 5 attempts: ${failures.join(" | ")}`);
}

function moveToTrash(target: string): void {
  if (existsSync(target)) execFileSync("trash", [target], { stdio: "ignore" });
}

function copyApplicationContents(application: string, destination: string): void {
  const sourceContents = path.join(application, "Contents");
  requireDirectory(application, "application");
  requireDirectory(sourceContents, "application Contents");
  invariant(readdirSync(destination).length === 0, "macOS DMG app placeholder is not empty");
  execFileSync("/usr/bin/ditto", [sourceContents, path.join(destination, "Contents")], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: "pipe",
  });
}

function attachImage(image: string, mountpoint: string, writable: boolean): void {
  const arguments_ = ["attach", "-nobrowse", "-noautoopen"];
  if (!writable) arguments_.push("-readonly");
  arguments_.push("-mountpoint", mountpoint, image);
  execFileSync("/usr/bin/hdiutil", arguments_, { stdio: "pipe" });
}

export function createMacOsDmg(application: string, output: string): void {
  requireDarwin();
  const presentation = loadPresentation();
  const resolvedApplication = path.resolve(application);
  const resolvedOutput = path.resolve(output);
  invariant(!existsSync(resolvedOutput), `macOS DMG output already exists: ${resolvedOutput}`);
  verifyTemplateFile(presentation);

  const temporary = mkdtempSync(path.join(tmpdir(), "mish-macos-dmg-"));
  const workingBase = path.join(temporary, "Mish-working");
  const compressedBase = path.join(temporary, "Mish-delivery");
  const mountpoint = path.join(temporary, "mount");
  let attached = false;
  try {
    execFileSync(
      "/usr/bin/hdiutil",
      ["convert", templatePath(presentation), "-format", "UDRW", "-o", workingBase],
      { stdio: "pipe" },
    );
    const workingImage = outputFromBase(workingBase);
    execFileSync(
      "/usr/bin/hdiutil",
      ["resize", "-size", `${imageSizeMiB(resolvedApplication)}m`, workingImage],
      {
        stdio: "pipe",
      },
    );
    mkdirSync(mountpoint);
    attachImage(workingImage, mountpoint, true);
    attached = true;
    assertTemplateRoot(mountpoint, presentation);
    copyApplicationContents(resolvedApplication, path.join(mountpoint, "Mish.app"));
    detachDiskImage(mountpoint);
    attached = false;

    execFileSync(
      "/usr/bin/hdiutil",
      [
        "convert",
        workingImage,
        "-format",
        "UDZO",
        "-imagekey",
        "zlib-level=9",
        "-o",
        compressedBase,
      ],
      { stdio: "pipe" },
    );
    copyFileSync(outputFromBase(compressedBase), resolvedOutput);
  } finally {
    if (attached) detachDiskImage(mountpoint);
    moveToTrash(temporary);
  }
}

export function verifyMacOsDmgPresentation(
  dmg: string,
  verifyApplication?: (application: string) => void,
): void {
  requireDarwin();
  const presentation = loadPresentation();
  const resolvedDmg = path.resolve(dmg);
  requireRegularFile(resolvedDmg, "delivery image");
  const temporary = mkdtempSync(path.join(tmpdir(), "mish-macos-dmg-verify-"));
  const mountpoint = path.join(temporary, "mount");
  let attached = false;
  try {
    mkdirSync(mountpoint);
    attachImage(resolvedDmg, mountpoint, false);
    attached = true;
    const canonicalMountpoint = realpathSync(mountpoint);
    const mountEvidence = execFileSync("/sbin/mount", [], { encoding: "utf8" });
    invariant(
      mountEvidence
        .split("\n")
        .some((line) => line.includes(` on ${canonicalMountpoint} `) && line.includes("read-only")),
      "macOS DMG verification did not mount the delivery image read-only",
    );
    const volumeName = execFileSync("/usr/sbin/diskutil", ["info", "-plist", mountpoint], {
      encoding: "utf8",
    });
    const observedVolumeName = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "VolumeName", "raw", "-o", "-", "-"],
      { encoding: "utf8", input: volumeName },
    ).trim();
    invariant(
      observedVolumeName === presentation.volumeName,
      `macOS DMG volume name differs: ${observedVolumeName}`,
    );
    const entries = readdirSync(mountpoint).sort();
    invariant(
      JSON.stringify(entries) === JSON.stringify(expectedRootEntries),
      `macOS DMG root contains unexpected entries: ${entries.join(", ")}`,
    );
    const visible = entries.filter((entry) => !entry.startsWith("."));
    invariant(
      JSON.stringify(visible) === JSON.stringify(expectedVisibleEntries),
      `macOS DMG exposes unexpected Finder items: ${visible.join(", ")}`,
    );
    const application = path.join(mountpoint, "Mish.app");
    const applications = path.join(mountpoint, "Applications");
    requireDirectory(application, "Mish.app");
    requireDirectory(path.join(application, "Contents"), "Mish.app Contents");
    invariant(
      lstatSync(applications).isSymbolicLink() && readlinkSync(applications) === "/Applications",
      "macOS DMG Applications alias must target /Applications",
    );
    invariant(
      sha256(path.join(mountpoint, presentation.background.file)) ===
        presentation.background.sha256,
      "macOS DMG background digest differs from the presentation contract",
    );
    invariant(
      sha256(path.join(mountpoint, ".DS_Store")) === presentation.template.dsStoreSha256,
      "macOS DMG Finder metadata digest differs from the presentation contract",
    );
    verifyApplication?.(realpathSync(application));
  } finally {
    if (attached) detachDiskImage(mountpoint);
    moveToTrash(temporary);
  }
}

export function macOsDmgPresentationContract(): MacOsDmgPresentation {
  return loadPresentation();
}

export function macOsDmgPresentationAssets(): { background: string; template: string } {
  const presentation = loadPresentation();
  return {
    background: path.join(
      presentationDirectory,
      presentation.background.file.replace(".background/", ""),
    ),
    template: templatePath(presentation),
  };
}
