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

function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return channel(1) * 0.2126 + channel(3) * 0.7152 + channel(5) * 0.0722;
}

function contrast(left: string, right: string): number {
  const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort(
    (first, second) => second - first,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}

function applicationFixture(internalTunPayload: boolean) {
  const temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-dmg-presentation-"));
  const application = path.join(temporary.path, "Mish.app");
  const executable = path.join(application, "Contents", "MacOS", "mish-desktop");
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(path.join(application, "Contents", "Info.plist"), "fixture");
  writeFileSync(executable, "fixture");
  chmodSync(executable, 0o755);
  if (internalTunPayload) {
    const controller = path.join(
      application,
      "Contents",
      "Resources",
      "internal-tun-alpha",
      "mish-internal-tun-alpha-ctl",
    );
    mkdirSync(path.dirname(controller), { recursive: true });
    writeFileSync(controller, "internal fixture");
    chmodSync(controller, 0o755);
  }
  return { application, temporary };
}

test("macOS DMG presentation locks its Finder-native template and visual contract", () => {
  const presentation = macOsDmgPresentationContract();
  const assets = macOsDmgPresentationAssets();

  assert.equal(presentation.volumeName, "Mish");
  assert.deepEqual(presentation.window, {
    position: { x: 180, y: 160 },
    size: { height: 410, width: 720 },
  });
  assert.equal(presentation.icons.size, 112);
  assert.equal(presentation.icons.textSize, 13);
  assert.deepEqual(presentation.icons.items, {
    "Mish.app": { x: 180, y: 240 },
    Applications: { x: 540, y: 240 },
  });
  assert.equal(presentation.background.instruction, "Drag Mish to Applications");
  assert.match(
    readFileSync(path.resolve("resources/macos-dmg/mish-install.svg"), "utf8"),
    /Drag Mish to Applications/u,
  );
  const background = readFileSync(path.resolve("resources/macos-dmg/mish-install.svg"), "utf8");
  assert.match(background, /<text[^>]+fill="#ffffff"/u);
  for (const surface of ["#70757d", "#6f7681"]) {
    assert.ok(
      contrast("#ffffff", surface) >= 4.5,
      `Instruction contrast is insufficient on ${surface}`,
    );
  }
  assert.ok(readFileSync(assets.template).byteLength > 0);
});

test(
  "standard production-compatible DMGs have only the two accessible Finder items",
  macOsOnly,
  () => {
    const fixture = applicationFixture(false);
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

test("Internal TUN Alpha DMGs hide their payload below Mish.app", macOsOnly, () => {
  const fixture = applicationFixture(true);
  using temporary = fixture.temporary;
  const dmg = path.join(temporary.path, "Mish-internal.dmg");
  const reproducedDmg = path.join(temporary.path, "Mish-internal-reproduced.dmg");

  createMacOsDmg(fixture.application, dmg, { normalizeForDeterminism: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
  createMacOsDmg(fixture.application, reproducedDmg, { normalizeForDeterminism: true });
  assert.deepEqual(readFileSync(reproducedDmg), readFileSync(dmg));
  verifyMacOsDmgPresentation(dmg, (application) => {
    assert.ok(
      readFileSync(
        path.join(
          application,
          "Contents",
          "Resources",
          "internal-tun-alpha",
          "mish-internal-tun-alpha-ctl",
        ),
      ).byteLength > 0,
    );
  });
});

test("routine DMG assembly has no Finder or open invocation", () => {
  const assembler = readFileSync(
    path.join(import.meta.dirname, "macos-dmg-presentation.ts"),
    "utf8",
  );
  const builder = readFileSync(path.join(import.meta.dirname, "build-macos-bundle.ts"), "utf8");
  const staging = readFileSync(
    path.join(import.meta.dirname, "internal-tun-alpha-staging.ts"),
    "utf8",
  );
  const stageVerifier = readFileSync(
    path.join(import.meta.dirname, "verify-internal-tun-alpha-stage.ts"),
    "utf8",
  );

  assert.doesNotMatch(assembler, /osascript/u);
  assert.doesNotMatch(assembler, /"\/usr\/bin\/open"/u);
  assert.match(assembler, /"-nobrowse", "-noautoopen"/u);
  assert.match(assembler, /arguments_\.push\("-readonly"/u);
  assert.match(assembler, /moveToTrash\(resolvedOutput\);/u);
  assert.match(builder, /replaceExistingOutput: true/u);
  assert.match(builder, /if \(openDmg\) execFileSync\("\/usr\/bin\/open"/u);
  assert.match(builder, /Mish-production-fixture_0\.1\.0_aarch64\.dmg/u);
  assert.match(builder, /verifyMacOsDmgPresentation\(dmg, \(mountedApplication\)/u);
  assert.match(
    staging,
    /createMacOsDmg\(application, destination, \{ normalizeForDeterminism: true \}\)/u,
  );
  assert.doesNotMatch(staging, /makehybrid|hfs-iso9660/u);
  assert.match(stageVerifier, /verifyMacOsDmgPresentation\(dmg/u);
  assert.doesNotMatch(stageVerifier, /makehybrid|hfs-iso9660/u);
});
