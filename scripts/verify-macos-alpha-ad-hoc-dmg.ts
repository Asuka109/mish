import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

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

  let mountpoint = "";
  let attached = false;
  try {
    const attachment = execFileSync(
      "hdiutil",
      ["attach", "-readonly", "-nobrowse", "-noautoopen", dmg],
      {
        encoding: "utf8",
      },
    );
    mountpoint = attachment.trim().split("\n").at(-1)?.split("\t").at(-1)?.trim() ?? "";
    if (!mountpoint.startsWith("/")) {
      throw new Error(`Alpha DMG did not expose a mount point: ${attachment}`);
    }
    attached = true;

    const application = path.join(mountpoint, "Mish.app");
    const applications = path.join(mountpoint, "Applications");
    if (!lstatSync(application).isDirectory()) {
      throw new Error("Alpha DMG does not contain Mish.app");
    }
    if (
      !lstatSync(applications).isSymbolicLink() ||
      readlinkSync(applications) !== "/Applications"
    ) {
      throw new Error("Alpha DMG Applications shortcut must be the /Applications symlink");
    }

    execFileSync("pnpm", ["desktop:bundle:verify:macos"], {
      env: {
        ...process.env,
        MISH_MACOS_APP_PATH: application,
        MISH_MACOS_PACKAGE_MODE: "alpha-ad-hoc",
      },
      stdio: "inherit",
    });
    console.log(`Verified read-only alpha-ad-hoc DMG: ${dmg}`);
  } finally {
    if (attached) await detachMacOsDiskImage(mountpoint);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await verifyMacOsAlphaAdHocDmg();
}
