import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function readJson(relativePath: string) {
  return JSON.parse(read(relativePath)) as Record<string, unknown>;
}

test("unused Web dependency facades stay deleted", () => {
  const uiPackage = readJson("packages/ui/package.json");
  const webPackage = readJson("apps/web/package.json");
  const uiSource = read("packages/ui/src/index.tsx");
  const lockfile = read("pnpm-lock.yaml");

  assert.equal((uiPackage.dependencies as Record<string, string>).cmdk, undefined);
  assert.doesNotMatch(
    uiSource,
    /from ["']cmdk["']|export function Command(?:Input|List|Empty|Group|Item)?\b/u,
  );
  assert.doesNotMatch(lockfile, /^  cmdk@/mu);

  assert.equal((webPackage.dependencies as Record<string, string>)["react-is"], undefined);
  assert.doesNotMatch(lockfile, /^      react-is:\n\s+specifier:/mu);
  assert.match(lockfile, /^  react-is@19\.2\.7:/mu);
  assert.match(lockfile, /^  recharts@[^\n]+:\n(?:.*\n)*?\s+react-is: 19\.2\.7$/mu);
});

test("one registered desktop dialog backend owns open and save pickers", () => {
  const cargoManifest = read("apps/desktop/src-tauri/Cargo.toml");
  const cargoLock = read("Cargo.lock");
  const desktopSource = read("apps/desktop/src-tauri/src/lib.rs");

  assert.doesNotMatch(cargoManifest, /^rfd\s*=/mu);
  assert.equal([...cargoLock.matchAll(/^name = "rfd"$/gmu)].length, 1);
  assert.match(cargoLock, /name = "rfd"\nversion = "0\.16\.0"/u);
  assert.doesNotMatch(desktopSource, /\brfd::/u);
  assert.match(desktopSource, /\.plugin\(tauri_plugin_dialog::init\(\)\)/u);
  assert.equal([...desktopSource.matchAll(/\.blocking_pick_file\(\)/gu)].length, 2);
  assert.equal([...desktopSource.matchAll(/\.blocking_save_file\(\)/gu)].length, 2);
  assert.equal(
    [...desktopSource.matchAll(/spawn_blocking\(move \|\| \{\n\s+app\.dialog\(\)/gu)].length,
    4,
  );
});

test("native picker commands remain desktop-only capabilities", () => {
  const desktopCapability = readJson("apps/desktop/src-tauri/capabilities/main.json");
  const desktopPermissions = desktopCapability.permissions as string[];
  assert.ok(desktopPermissions.includes("allow-profile-preflight-local"));
  assert.ok(desktopPermissions.includes("allow-local-backup-restore-preview"));
  assert.ok(desktopPermissions.every((permission) => !permission.startsWith("dialog:")));

  const mobileCapabilitiesDirectory = resolve(root, "apps/mobile/src-tauri/capabilities");
  for (const entry of readdirSync(mobileCapabilitiesDirectory)) {
    if (!entry.endsWith(".json")) continue;
    const capability = readJson(`apps/mobile/src-tauri/capabilities/${entry}`);
    const permissions = capability.permissions as string[];
    assert.ok(permissions.every((permission) => !permission.includes("profile-preflight-local")));
    assert.ok(permissions.every((permission) => !permission.includes("local-backup-restore")));
    assert.ok(permissions.every((permission) => !permission.startsWith("dialog:")));
  }
});
