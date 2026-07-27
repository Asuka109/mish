import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  productionHelperRelativePath,
  productionPlistRelativePath,
  verifyMacOsPrivilegedBundle,
} from "./macos-privileged-bundle.ts";

function fixture(production = true) {
  const temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-bundle-gate-"));
  const application = path.join(temporary.path, "Mish.app");
  mkdirSync(path.join(application, "Contents", "Resources"), { recursive: true });
  if (production) {
    const helper = path.join(application, productionHelperRelativePath);
    const plist = path.join(application, productionPlistRelativePath);
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(helper, "fixture-helper");
    copyFileSync(
      path.resolve("apps/desktop/src-tauri/macos/LaunchDaemons/com.asuka109.mish.tun-helper.plist"),
      plist,
    );
    chmodSync(helper, 0o555);
    chmodSync(plist, 0o444);
  }
  return { application, temporary };
}

test("accepts the exact production layout and an empty ad-hoc layout", async () => {
  using production = fixture().temporary;
  const productionApplication = path.join(production.path, "Mish.app");
  await verifyMacOsPrivilegedBundle(productionApplication, "production");

  const adHocFixture = fixture(false);
  using adHoc = adHocFixture.temporary;
  await verifyMacOsPrivilegedBundle(adHocFixture.application, "ad-hoc");
});

test("rejects missing and misplaced privileged artifacts", async () => {
  const missingFixture = fixture(false);
  using missing = missingFixture.temporary;
  await assert.rejects(
    verifyMacOsPrivilegedBundle(missingFixture.application, "production"),
    /missing privileged artifact/u,
  );

  const misplacedFixture = fixture(false);
  using misplaced = misplacedFixture.temporary;
  const misplacedHelper = path.join(misplacedFixture.application, "Contents/MacOS/mish-tun-helper");
  mkdirSync(path.dirname(misplacedHelper), { recursive: true });
  writeFileSync(misplacedHelper, "fixture-helper");
  chmodSync(misplacedHelper, 0o555);
  await assert.rejects(
    verifyMacOsPrivilegedBundle(misplacedFixture.application, "ad-hoc"),
    /contains privileged artifacts/u,
  );
});

test("rejects mutable, linked, duplicate, and unexpected privileged artifacts", async () => {
  const mutableFixture = fixture();
  using mutable = mutableFixture.temporary;
  chmodSync(path.join(mutableFixture.application, productionHelperRelativePath), 0o777);
  await assert.rejects(
    verifyMacOsPrivilegedBundle(mutableFixture.application, "production"),
    /group- or world-writable/u,
  );

  const symlinkFixture = fixture();
  using symlink = symlinkFixture.temporary;
  const helper = path.join(symlinkFixture.application, productionHelperRelativePath);
  const movedHelper = path.join(symlink.path, "real-helper");
  renameSync(helper, movedHelper);
  symlinkSync(movedHelper, helper);
  await assert.rejects(
    verifyMacOsPrivilegedBundle(symlinkFixture.application, "production"),
    /not a regular file/u,
  );

  const hardLinkFixture = fixture();
  using hardLink = hardLinkFixture.temporary;
  const linkedHelper = path.join(hardLinkFixture.application, productionHelperRelativePath);
  linkSync(linkedHelper, path.join(hardLink.path, "helper-hard-link"));
  await assert.rejects(
    verifyMacOsPrivilegedBundle(hardLinkFixture.application, "production"),
    /duplicate hard links/u,
  );

  const extraFixture = fixture();
  using extra = extraFixture.temporary;
  writeFileSync(
    path.join(
      extraFixture.application,
      "Contents/Library/LaunchDaemons/com.example.unexpected.plist",
    ),
    "unexpected",
  );
  await assert.rejects(
    verifyMacOsPrivilegedBundle(extraFixture.application, "production"),
    /unexpected privileged artifacts/u,
  );

  const changedPlistFixture = fixture();
  using changedPlist = changedPlistFixture.temporary;
  const changedPlistPath = path.join(changedPlistFixture.application, productionPlistRelativePath);
  chmodSync(changedPlistPath, 0o644);
  writeFileSync(changedPlistPath, "changed");
  chmodSync(changedPlistPath, 0o444);
  await assert.rejects(
    verifyMacOsPrivilegedBundle(changedPlistFixture.application, "production"),
    /does not match the repository contract/u,
  );
});

test("rejects any privileged artifact in ad-hoc packages", async () => {
  const bundledFixture = fixture();
  using bundled = bundledFixture.temporary;
  await assert.rejects(
    verifyMacOsPrivilegedBundle(bundledFixture.application, "ad-hoc"),
    /contains privileged artifacts/u,
  );
});

test("rejects development Core-host artifacts from every release bundle mode", async () => {
  const adHocFixture = fixture(false);
  using adHoc = adHocFixture.temporary;
  const adHocHelper = path.join(
    adHocFixture.application,
    "Contents/Resources/com.asuka109.mish.tun-helper.dev",
  );
  mkdirSync(path.dirname(adHocHelper), { recursive: true });
  writeFileSync(adHocHelper, "development-only");
  chmodSync(adHocHelper, 0o555);
  await assert.rejects(
    verifyMacOsPrivilegedBundle(adHocFixture.application, "ad-hoc"),
    /contains privileged artifacts/u,
  );

  const productionFixture = fixture();
  using production = productionFixture.temporary;
  writeFileSync(
    path.join(
      productionFixture.application,
      "Contents/Library/LaunchDaemons/com.asuka109.mish.tun-helper.dev.plist",
    ),
    "development-only",
  );
  await assert.rejects(
    verifyMacOsPrivilegedBundle(productionFixture.application, "production"),
    /unexpected privileged artifacts/u,
  );
});

test("rejects internal installation-key material from every release profile", async () => {
  for (const mode of ["ad-hoc", "production"] as const) {
    const bundle = fixture(mode === "production");
    using temporary = bundle.temporary;
    const credential = path.join(bundle.application, "Contents/Resources/tun-client-key.json");
    writeFileSync(credential, "must-not-ship");
    chmodSync(credential, 0o400);
    await assert.rejects(
      verifyMacOsPrivilegedBundle(bundle.application, mode),
      /privileged artifacts|unexpected privileged artifacts/u,
    );
  }
});

test("requires an explicit development feature to build Core-host executables", () => {
  const metadata = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    encoding: "utf8",
  });
  assert.equal(metadata.status, 0, metadata.stderr);
  const workspace = JSON.parse(metadata.stdout) as {
    packages: Array<{
      name: string;
      targets: Array<{ name: string; "required-features": string[] }>;
    }>;
  };
  const packageMetadata = workspace.packages.find(
    (candidate) => candidate.name === "mish-platform-macos",
  );
  assert.ok(packageMetadata);
  for (const name of ["mish-tun-helper", "mish-core-host-ctl"]) {
    const target = packageMetadata.targets.find((candidate) => candidate.name === name);
    assert.deepEqual(target?.["required-features"], ["development-core-host"]);
  }

  const desktopPackage = workspace.packages.find((candidate) => candidate.name === "mish-desktop");
  assert.ok(desktopPackage);
  const desktopManifest = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const script of [
    "build",
    "bundle:macos",
    "bundle:macos:alpha-ad-hoc",
    "bundle:macos:production",
  ]) {
    assert.doesNotMatch(desktopManifest.scripts[script] ?? "", /development-core-host/u);
  }
});
