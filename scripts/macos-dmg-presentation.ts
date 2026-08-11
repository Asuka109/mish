import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertPrivateNoFollowFile,
  assertPrivateNoFollowRoot,
  readContainedReleaseFile,
  writeContainedReleaseFile,
} from "./release-path-containment.ts";

const presentationFile = path.resolve("resources/macos-dmg/presentation.json");
const presentationDirectory = path.dirname(presentationFile);
const expectedRootEntries = [".DS_Store", ".background", "Applications", "Mish.app"] as const;
const expectedVisibleEntries = ["Applications", "Mish.app"] as const;
const minimumImageMiB = 128;
const imageOverheadMiB = 64;
const hfsEpochOffsetSeconds = 2_082_844_800;
const deterministicTimestampSeconds = Math.floor(
  new Date("2020-01-01T00:00:00.000Z").getTime() / 1000,
);

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

type DetachRunner = (
  command: string,
  arguments_: string[],
) => { status: number | null; stderr?: string | Buffer | null };

type DetachPause = (milliseconds: number) => void;

export type CreateMacOsDmgOptions = {
  normalizeForDeterminism?: boolean;
  replaceExistingOutput?: boolean;
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
      parsed.window.size?.width === 540 &&
      parsed.window.size.height === 380 &&
      parsed.icons &&
      parsed.icons.size === 80 &&
      parsed.icons.textSize === 13 &&
      isPoint(parsed.icons.items?.["Mish.app"]) &&
      parsed.icons.items["Mish.app"].x === 140 &&
      parsed.icons.items["Mish.app"].y === 190 &&
      isPoint(parsed.icons.items?.Applications) &&
      parsed.icons.items.Applications.x === 410 &&
      parsed.icons.items.Applications.y === 190,
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

function pauseDetachRetry(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export function detachMacOsDiskImage(
  mountpoint: string,
  runner: DetachRunner = (command, arguments_) =>
    spawnSync(command, arguments_, { encoding: "utf8" }),
  pause: DetachPause = pauseDetachRetry,
): void {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = runner("/usr/bin/hdiutil", ["detach", mountpoint]);
    if (result.status === 0) return;
    failures.push(String(result.stderr ?? "").trim() || `exit ${String(result.status)}`);
    if (attempt < 5) pause(attempt * 250);
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

function normalizeHfsMetadata(image: string): void {
  const bytes = readFileSync(image);
  const hfsHeaderCandidates: Array<{
    allocationBlockSize: number;
    offset: number;
    totalAllocationBlocks: number;
  }> = [];
  const hfsHeaderSignature = Buffer.from([0x48, 0x2b, 0, 4]);
  for (
    let offset = bytes.indexOf(hfsHeaderSignature);
    offset >= 0;
    offset = bytes.indexOf(hfsHeaderSignature, offset + hfsHeaderSignature.length)
  ) {
    if (offset + 112 > bytes.length) continue;
    const allocationBlockSize = bytes.readUInt32BE(offset + 40);
    const totalAllocationBlocks = bytes.readUInt32BE(offset + 44);
    const freeAllocationBlocks = bytes.readUInt32BE(offset + 48);
    if (
      allocationBlockSize >= 512 &&
      (allocationBlockSize & (allocationBlockSize - 1)) === 0 &&
      totalAllocationBlocks > 0 &&
      freeAllocationBlocks <= totalAllocationBlocks
    ) {
      hfsHeaderCandidates.push({ allocationBlockSize, offset, totalAllocationBlocks });
    }
  }
  const hfsHeaderPairs = hfsHeaderCandidates.flatMap((primary) => {
    const alternateOffset =
      primary.offset + primary.allocationBlockSize * primary.totalAllocationBlocks - 2_048;
    const alternate = hfsHeaderCandidates.find(
      (candidate) =>
        candidate.offset === alternateOffset &&
        candidate.allocationBlockSize === primary.allocationBlockSize &&
        candidate.totalAllocationBlocks === primary.totalAllocationBlocks,
    );
    return alternate ? [{ alternate, primary }] : [];
  });
  invariant(
    hfsHeaderPairs.length === 1,
    "macOS DMG must contain one bounded HFS+ volume header pair",
  );
  const { alternate, primary } = hfsHeaderPairs[0]!;
  const fixedHfsTimestamp = Buffer.alloc(4);
  fixedHfsTimestamp.writeUInt32BE(deterministicTimestampSeconds + hfsEpochOffsetSeconds);
  const fixedBsdTimestamp = Buffer.alloc(4);
  fixedBsdTimestamp.writeUInt32BE(deterministicTimestampSeconds);
  const fixedVolumeId = createHash("sha256")
    .update("Mish Finder DMG HFS volume v2")
    .digest()
    .subarray(0, 8);
  for (const offset of [primary.offset, alternate.offset]) {
    for (const dateOffset of [16, 20, 24, 28]) {
      fixedHfsTimestamp.copy(bytes, offset + dateOffset);
    }
    fixedVolumeId.copy(bytes, offset + 104);
  }

  const volumeStart = primary.offset - 1_024;
  invariant(volumeStart >= 0, "macOS DMG HFS+ volume start is invalid");
  const catalogLogicalSize = Number(bytes.readBigUInt64BE(primary.offset + 272));
  const catalogBlockCount = bytes.readUInt32BE(primary.offset + 284);
  const catalogAllocatedSize = catalogBlockCount * primary.allocationBlockSize;
  invariant(
    Number.isSafeInteger(catalogLogicalSize) &&
      catalogLogicalSize > 0 &&
      catalogLogicalSize <= catalogAllocatedSize,
    "macOS DMG HFS+ catalog size is invalid",
  );
  const catalog = Buffer.alloc(catalogAllocatedSize);
  const catalogExtents: Array<{ blockCount: number; physicalOffset: number }> = [];
  let catalogOffset = 0;
  for (let extent = 0; extent < 8; extent += 1) {
    const startBlock = bytes.readUInt32BE(primary.offset + 288 + extent * 8);
    const blockCount = bytes.readUInt32BE(primary.offset + 292 + extent * 8);
    if (blockCount === 0) {
      invariant(startBlock === 0, "macOS DMG HFS+ catalog has a partial extent");
      continue;
    }
    invariant(
      startBlock < primary.totalAllocationBlocks &&
        blockCount <= primary.totalAllocationBlocks - startBlock &&
        catalogOffset + blockCount * primary.allocationBlockSize <= catalog.length,
      "macOS DMG HFS+ catalog extent is invalid",
    );
    const physicalOffset = volumeStart + startBlock * primary.allocationBlockSize;
    const byteLength = blockCount * primary.allocationBlockSize;
    invariant(
      physicalOffset >= 0 && physicalOffset + byteLength <= bytes.length,
      "macOS DMG HFS+ catalog extent exceeds the image",
    );
    bytes.copy(catalog, catalogOffset, physicalOffset, physicalOffset + byteLength);
    catalogExtents.push({ blockCount, physicalOffset });
    catalogOffset += byteLength;
  }
  invariant(
    catalogOffset === catalog.length && catalogExtents.length > 0,
    "macOS DMG HFS+ catalog requires unsupported overflow extents",
  );

  invariant(
    catalog.readInt8(8) === 1 && catalog.readUInt16BE(10) >= 3,
    "macOS DMG HFS+ catalog header node is invalid",
  );
  const expectedLeafRecords = catalog.readUInt32BE(20);
  const nodeSize = catalog.readUInt16BE(32);
  const totalNodes = catalog.readUInt32BE(36);
  invariant(
    nodeSize >= 512 &&
      (nodeSize & (nodeSize - 1)) === 0 &&
      totalNodes > 0 &&
      totalNodes * nodeSize <= catalogLogicalSize,
    "macOS DMG HFS+ catalog B-tree shape is invalid",
  );
  let leafRecords = 0;
  let normalizedRecords = 0;
  for (let node = 0; node < totalNodes; node += 1) {
    const nodeOffset = node * nodeSize;
    if (catalog.readInt8(nodeOffset + 8) !== -1) continue;
    const recordCount = catalog.readUInt16BE(nodeOffset + 10);
    const offsetTableStart = nodeOffset + nodeSize - (recordCount + 1) * 2;
    invariant(
      recordCount > 0 && offsetTableStart >= nodeOffset + 14,
      "macOS DMG HFS+ catalog leaf inventory is invalid",
    );
    let previousRecordOffset = 13;
    for (let record = 0; record < recordCount; record += 1) {
      const recordOffset = catalog.readUInt16BE(nodeOffset + nodeSize - (record + 1) * 2);
      invariant(
        recordOffset > previousRecordOffset && nodeOffset + recordOffset + 4 <= offsetTableStart,
        "macOS DMG HFS+ catalog record offset is invalid",
      );
      previousRecordOffset = recordOffset;
      const keyLength = catalog.readUInt16BE(nodeOffset + recordOffset);
      const dataOffset = nodeOffset + recordOffset + ((keyLength + 3) & ~1);
      invariant(dataOffset + 2 <= offsetTableStart, "macOS DMG HFS+ catalog record key is invalid");
      const recordType = catalog.readInt16BE(dataOffset);
      if (recordType === 1 || recordType === 2) {
        const recordSize = recordType === 1 ? 88 : 248;
        invariant(
          dataOffset + recordSize <= offsetTableStart,
          "macOS DMG HFS+ catalog record is truncated",
        );
        for (const dateOffset of [12, 16, 20, 24, 28]) {
          fixedHfsTimestamp.copy(catalog, dataOffset + dateOffset);
        }
        fixedBsdTimestamp.copy(catalog, dataOffset + 68);
        normalizedRecords += 1;
      } else {
        invariant(
          recordType === 3 || recordType === 4,
          "macOS DMG HFS+ catalog contains an unsupported record type",
        );
      }
      leafRecords += 1;
    }
  }
  invariant(
    leafRecords === expectedLeafRecords && normalizedRecords > 0,
    "macOS DMG HFS+ catalog leaf inventory is incomplete",
  );

  catalogOffset = 0;
  for (const extent of catalogExtents) {
    const byteLength = extent.blockCount * primary.allocationBlockSize;
    catalog.copy(bytes, extent.physicalOffset, catalogOffset, catalogOffset + byteLength);
    catalogOffset += byteLength;
  }
  writeFileSync(image, bytes);
}

function normalizeUdifSegmentId(image: string): void {
  const bytes = readFileSync(image);
  const footerOffset = bytes.length - 512;
  invariant(
    footerOffset >= 0 &&
      bytes.toString("ascii", footerOffset, footerOffset + 4) === "koly" &&
      bytes.readUInt32BE(footerOffset + 4) === 4 &&
      bytes.readUInt32BE(footerOffset + 8) === 512 &&
      bytes.readUInt32BE(footerOffset + 56) === 1 &&
      bytes.readUInt32BE(footerOffset + 60) === 1,
    "macOS DMG deterministic UDIF footer is invalid",
  );
  createHash("sha256")
    .update("Mish deterministic UDIF segment v1")
    .digest()
    .subarray(0, 16)
    .copy(bytes, footerOffset + 64);
  writeFileSync(image, bytes);
}

export function createMacOsDmg(
  application: string,
  output: string,
  options: CreateMacOsDmgOptions = {},
): void {
  requireDarwin();
  const presentation = loadPresentation();
  const resolvedApplication = path.resolve(application);
  const resolvedOutput = path.resolve(output);
  const applicationRoot = assertPrivateNoFollowRoot(resolvedApplication);
  const outputRoot = assertPrivateNoFollowRoot(path.dirname(resolvedOutput));
  applicationRoot.assertCurrent();
  if (existsSync(resolvedOutput)) {
    assertPrivateNoFollowFile(resolvedOutput);
    requireRegularFile(resolvedOutput, "existing output");
    invariant(options.replaceExistingOutput, `macOS DMG output already exists: ${resolvedOutput}`);
  }
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
    applicationRoot.assertCurrent();
    copyApplicationContents(resolvedApplication, path.join(mountpoint, "Mish.app"));
    detachMacOsDiskImage(mountpoint);
    attached = false;
    if (options.normalizeForDeterminism) {
      normalizeHfsMetadata(workingImage);
    }

    const conversionArguments = [
      "convert",
      workingImage,
      "-format",
      options.normalizeForDeterminism ? "UDBZ" : "UDZO",
    ];
    if (!options.normalizeForDeterminism) {
      conversionArguments.push("-imagekey", "zlib-level=9");
    }
    conversionArguments.push("-o", compressedBase);
    execFileSync("/usr/bin/hdiutil", conversionArguments, { stdio: "pipe" });
    const assembledOutput = outputFromBase(compressedBase);
    requireRegularFile(assembledOutput, "assembled delivery image");
    if (options.normalizeForDeterminism) normalizeUdifSegmentId(assembledOutput);
    moveToTrash(resolvedOutput);
    const assembled = assertPrivateNoFollowFile(assembledOutput);
    writeContainedReleaseFile(
      outputRoot,
      path.basename(resolvedOutput),
      readContainedReleaseFile(assembled),
      { mode: 0o644 },
    );
    assertPrivateNoFollowFile(resolvedOutput).assertCurrent();
  } finally {
    if (attached) detachMacOsDiskImage(mountpoint);
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
  const dmgGuard = assertPrivateNoFollowFile(resolvedDmg);
  requireRegularFile(dmgGuard.absolute, "delivery image");
  const temporary = mkdtempSync(path.join(tmpdir(), "mish-macos-dmg-verify-"));
  const mountpoint = path.join(temporary, "mount");
  let attached = false;
  try {
    mkdirSync(mountpoint);
    dmgGuard.assertCurrent();
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
    const mountedApplication = realpathSync(application);
    const mountedRoot = assertPrivateNoFollowRoot(mountedApplication);
    mountedRoot.assertCurrent();
    verifyApplication?.(mountedRoot.absolute);
  } finally {
    if (attached) detachMacOsDiskImage(mountpoint);
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
