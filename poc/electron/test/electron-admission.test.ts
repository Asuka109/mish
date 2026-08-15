import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const fixtureScript = fileURLToPath(new URL("../scripts/electron-fixture.ts", import.meta.url));

const archive = process.env.MISH_ELECTRON_ARCHIVE;

describe("real Electron admission", () => {
  it.skipIf(!archive)(
    "launches the sandboxed app from a read-only DMG and quits cleanly",
    async () => {
      process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
      const { assembleElectronFixture, launchMountedDmgAndQuit, verifyTranscript } = await import(
        fixtureScript
      );
      const fixture = await assembleElectronFixture({ archive: archive! });
      const launch = launchMountedDmgAndQuit(fixture);
      expect(launch.exitCode).toBe(0);
      verifyTranscript(launch.output);
      expect(launch.output).toContain("MISH_ELECTRON_TRANSCRIPT");
      console.log(`P4_DMG=${fixture.dmg}`);
    },
    180_000,
  );
});
