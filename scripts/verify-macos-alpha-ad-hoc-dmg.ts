import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import path from "node:path";

const dmg = path.resolve(
  process.env.MISH_MACOS_DMG_PATH ?? "target/release/bundle/dmg/Mish_0.1.0_aarch64.dmg",
);
if (!existsSync(dmg)) {
  throw new Error(`Alpha DMG is missing: ${dmg}`);
}

let mountpoint = "";
let attached = false;
try {
  const attachment = execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", dmg], {
    encoding: "utf8",
  });
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
  if (!lstatSync(applications).isSymbolicLink() || readlinkSync(applications) !== "/Applications") {
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
  if (attached) {
    execFileSync("hdiutil", ["detach", mountpoint], { stdio: "inherit" });
  }
}
