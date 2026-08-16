import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createMacOsDmg,
  macOsDmgPresentationAssets,
  macOsDmgPresentationContract,
  verifyMacOsDmgPresentation,
} from "./macos-dmg-presentation.ts";

const macOsOnly = { skip: process.platform !== "darwin" };

function readPngHeader(file: string) {
  const bytes = readFileSync(file);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${file} must be a PNG file`,
  );
  let pixelsPerMeterX: number | undefined;
  let pixelsPerMeterY: number | undefined;
  let resolutionUnit: number | undefined;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "pHYs" && length === 9) {
      pixelsPerMeterX = bytes.readUInt32BE(offset + 8);
      pixelsPerMeterY = bytes.readUInt32BE(offset + 12);
      resolutionUnit = bytes[offset + 16];
      break;
    }
    offset += length + 12;
  }
  return {
    bitDepth: bytes[24],
    colorType: bytes[25],
    height: bytes.readUInt32BE(20),
    pixelsPerMeterX,
    pixelsPerMeterY,
    resolutionUnit,
    width: bytes.readUInt32BE(16),
  };
}

function applicationFixture() {
  const temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-dmg-presentation-"));
  const application = path.join(temporary.path, "Mish.app");
  const executable = path.join(application, "Contents", "MacOS", "mish-desktop");
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(path.join(application, "Contents", "Info.plist"), "fixture");
  writeFileSync(executable, "fixture");
  chmodSync(executable, 0o755);
  return { application, temporary };
}

test("macOS DMG presentation locks its Finder-native template and visual contract", () => {
  const presentation = macOsDmgPresentationContract();
  const assets = macOsDmgPresentationAssets();

  assert.equal(presentation.volumeName, "Mish");
  assert.deepEqual(presentation.window, {
    position: { x: 180, y: 160 },
    size: { height: 380, width: 540 },
  });
  assert.equal(presentation.icons.size, 80);
  assert.equal(presentation.icons.textSize, 13);
  assert.deepEqual(presentation.icons.items, {
    "Mish.app": { x: 140, y: 190 },
    Applications: { x: 410, y: 190 },
  });
  assert.equal(presentation.background.instruction, "Drag Mish to Applications");
  const backgroundSvg = readFileSync(path.resolve("resources/macos-dmg/mish-install.svg"), "utf8");
  assert.match(backgroundSvg, /<svg[^>]+width="1080"[^>]+height="760"/u);
  assert.doesNotMatch(backgroundSvg, /<text\b/u);
  assert.match(backgroundSvg, /M526 362L540 380L526 398/u);
  assert.match(backgroundSvg, /M540 362L554 380L540 398/u);
  assert.deepEqual(readPngHeader(assets.background), {
    bitDepth: 8,
    colorType: 2,
    height: 760,
    pixelsPerMeterX: 5669,
    pixelsPerMeterY: 5669,
    resolutionUnit: 1,
    width: 1080,
  });
  assert.ok(readFileSync(assets.template).byteLength > 0);
});

test(
  "standard production-compatible DMGs have only the two accessible Finder items",
  macOsOnly,
  () => {
    const fixture = applicationFixture();
    using temporary = fixture.temporary;
    const dmg = path.join(temporary.path, "Mish-standard.dmg");

    createMacOsDmg(fixture.application, dmg);
    assert.throws(
      () => createMacOsDmg(fixture.application, dmg),
      /macOS DMG output already exists/u,
    );
    createMacOsDmg(fixture.application, dmg, { replaceExistingOutput: true });
    verifyMacOsDmgPresentation(dmg, (application) => {
      assert.equal(path.basename(application), "Mish.app");
      assert.ok(readFileSync(path.join(application, "Contents", "Info.plist")).byteLength > 0);
    });
  },
);

test("deterministic DMG assembly reproduces the same credential-free fixture", macOsOnly, () => {
  const fixture = applicationFixture();
  using temporary = fixture.temporary;
  const dmg = path.join(temporary.path, "Mish-fixture.dmg");
  const reproducedDmg = path.join(temporary.path, "Mish-fixture-reproduced.dmg");

  createMacOsDmg(fixture.application, dmg, { normalizeForDeterminism: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
  createMacOsDmg(fixture.application, reproducedDmg, { normalizeForDeterminism: true });
  assert.deepEqual(readFileSync(reproducedDmg), readFileSync(dmg));
  verifyMacOsDmgPresentation(dmg, (application) => {
    assert.equal(path.basename(application), "Mish.app");
    assert.ok(readFileSync(path.join(application, "Contents", "Info.plist")).byteLength > 0);
  });
});

test("routine DMG assembly has no Finder or open invocation", () => {
  const assembler = readFileSync(
    path.join(import.meta.dirname, "macos-dmg-presentation.ts"),
    "utf8",
  );
  assert.doesNotMatch(assembler, /osascript/u);
  assert.doesNotMatch(assembler, /"\/usr\/bin\/open"/u);
  assert.match(assembler, /"-nobrowse", "-noautoopen"/u);
  assert.match(assembler, /arguments_\.push\("-readonly"/u);
  assert.match(assembler, /moveToTrash\(resolvedOutput\);/u);
  assert.doesNotMatch(assembler, /\b(?:notarize|publish|signing|tauri|cargo|rust)\b/iu);
});
