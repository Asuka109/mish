import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { verifyMacOsDmgPresentation } from "./macos-dmg-presentation.ts";

export async function verifyMacOsAlphaAdHocDmg(): Promise<void> {
  const dmg = path.resolve(
    process.env.MISH_MACOS_DMG_PATH ?? "target/release/bundle/dmg/Mish_0.1.0_aarch64.dmg",
  );
  if (!existsSync(dmg)) {
    throw new Error(`Alpha DMG is missing: ${dmg}`);
  }

  verifyMacOsDmgPresentation(dmg, (application) => {
    execFileSync("pnpm", ["desktop:bundle:verify:macos"], {
      env: {
        ...process.env,
        MISH_MACOS_APP_PATH: application,
        MISH_MACOS_PACKAGE_MODE: "alpha-ad-hoc",
      },
      stdio: "inherit",
    });
  });
  console.log(`Verified read-only alpha-ad-hoc DMG: ${dmg}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await verifyMacOsAlphaAdHocDmg();
}
