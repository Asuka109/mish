import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { verifyMacOsDmgPresentation } from "./macos-dmg-presentation.ts";

type DetachRunner = (
  command: string,
  arguments_: string[],
) => { status: number | null; stderr?: string | Buffer | null };

export async function detachMacOsDiskImage(
  mountpoint: string,
  runner: DetachRunner = (command, arguments_) =>
    spawnSync(command, arguments_, { encoding: "utf8" }),
  pause: (milliseconds: number) => Promise<unknown> = wait,
): Promise<void> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = runner("hdiutil", ["detach", mountpoint]);
    if (result.status === 0) return;
    failures.push(String(result.stderr ?? "").trim() || `exit ${String(result.status)}`);
    if (attempt < 5) await pause(attempt * 250);
  }
  throw new Error(
    `Could not cleanly detach ${mountpoint} after 5 attempts: ${failures.join(" | ")}`,
  );
}

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
