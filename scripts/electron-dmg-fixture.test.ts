import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const source = readFileSync(path.join(root, "scripts", "electron-dmg-fixture.ts"), "utf8");
const packageJson = JSON.parse(
  readFileSync(path.join(root, "apps", "desktop-electron", "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

test("Electron DMG fixture is credential-free, deterministic, and read-only verified", () => {
  assert.match(source, /createMacOsDmg\(bundle, output, \{[\s\S]*normalizeForDeterminism: true/u);
  assert.match(source, /verifyMacOsDmgPresentation\(output, verifyFixtureBundle\)/u);
  assert.match(source, /\["--sign", "-", "--force", "--deep", bundle\]/u);
  assert.match(source, /\["--verify", "--deep", "--strict", bundle\]/u);
  assert.match(source, /Mish-Electron-Foundation-fixture\.dmg/u);
  assert.doesNotMatch(source, /Developer ID|notarytool|notarize|openDmg|open\(/u);
  assert.equal(
    packageJson.scripts?.["package:dmg:fixture"],
    "pnpm build && pnpm --dir ../.. exec node scripts/electron-dmg-fixture.ts",
  );
});
