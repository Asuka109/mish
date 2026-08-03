import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createInternalTunAlphaManifest,
  internalTunAlphaManifestRelativePath,
  internalTunAlphaPackageVersion,
  verifyInternalTunAlphaPackage,
} from "./internal-tun-alpha-package.ts";

const payload = "Contents/Resources/internal-tun-alpha";
const fixtureFiles = [
  [`${payload}/mish-internal-tun-alpha-ctl`, 0o755],
  [`${payload}/com.asuka109.mish.tun-helper.dev.plist.template`, 0o644],
  [`${payload}/mihomo`, 0o755],
  [`${payload}/mish-tun-helper`, 0o755],
  ["Contents/Info.plist", 0o644],
  ["Contents/MacOS/mish-desktop", 0o755],
  ["Contents/Resources/mihomo-aarch64-apple-darwin", 0o755],
  ["Contents/_CodeSignature/CodeResources", 0o644],
] as const;

const template = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.asuka109.mish.tun-helper.dev</string>
<key>ProgramArguments</key><array><string>/Library/PrivilegedHelperTools/com.asuka109.mish.tun-helper.dev</string></array>
<key>EnvironmentVariables</key><dict>
<key>MISH_TUN_SERVICE_ALLOWED_UID</key><string>__MISH_ALLOWED_UID__</string>
<key>MISH_TUN_SERVICE_ALLOW_TUN</key><string>1</string>
<key>MISH_TUN_SERVICE_CORE_BINARY</key><string>/Library/PrivilegedHelperTools/com.asuka109.mish.mihomo.dev</string>
<key>MISH_TUN_SERVICE_ENROLLMENT_RECORD</key><string>/Library/Application Support/com.asuka109.mish/tun-helper-dev/enrollment.json</string>
<key>MISH_TUN_SERVICE_INSTALLATION_ID</key><string>__MISH_INSTALLATION_ID__</string>
<key>MISH_TUN_SERVICE_RUNTIME_ROOT</key><string>__MISH_RUNTIME_ROOT_XML__</string>
<key>MISH_TUN_SERVICE_SOCKET</key><string>__MISH_SOCKET__</string>
</dict></dict></plist>
`;

async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), "mish-internal-tun-alpha-"));
  const parent = await realpath(temporary);
  const root = path.join(parent, "Mish-Internal-TUN-Alpha-fixture-arm64");
  const application = path.join(root, "Mish.app");
  await mkdir(path.join(application, payload), { recursive: true, mode: 0o755 });
  await mkdir(path.join(application, "Contents/MacOS"), { recursive: true, mode: 0o755 });
  await mkdir(path.join(application, "Contents/_CodeSignature"), { recursive: true, mode: 0o755 });
  await chmod(root, 0o755);
  for (const [relative, mode] of fixtureFiles) {
    const content = relative.endsWith(".plist.template") ? template : `fixture:${relative}\n`;
    const file = path.join(application, relative);
    await writeFile(file, content, { mode });
    await chmod(file, mode);
  }
  const manifest = await createInternalTunAlphaManifest(application, {
    coreVersion: "v1.19.29",
    helperVersion: "3",
  });
  const manifestFile = path.join(application, internalTunAlphaManifestRelativePath);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await chmod(manifestFile, 0o644);
  return {
    application,
    manifest,
    manifestFile,
    parent,
    root,
    verify: () =>
      verifyInternalTunAlphaPackage(root, {
        expectedOwnerUid: process.getuid!(),
        validateMacOsBinaries: false,
      }),
  };
}

async function withFixture(
  operation: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const value = await fixture();
  try {
    await operation(value);
  } finally {
    await rm(value.parent, { force: true, recursive: true });
  }
}

test("accepts the closed embedded Internal TUN Alpha application package", async () => {
  await withFixture(async ({ application, verify }) => {
    const manifest = await verify();
    assert.equal(manifest.packageVersion, internalTunAlphaPackageVersion);
    assert.equal(manifest.profile, "internal-tun-alpha");
    assert.equal(manifest.allowTun, true);
    assert.equal(manifest.networkMutationEnabled, true);
    assert.equal(manifest.developerIdRequired, false);
    assert.equal(manifest.protocolVersion, 3);
    assert.equal(manifest.files.length, 6);
    assert.equal(
      manifest.files.some((file) => file.path === "Contents/MacOS/mish-desktop"),
      false,
    );
    const direct = await verifyInternalTunAlphaPackage(application, {
      expectedOwnerUid: process.getuid!(),
      validateMacOsBinaries: false,
    });
    assert.equal(direct.packageVersion, internalTunAlphaPackageVersion);
  });
});

test("package build embeds the operational payload and signs the enclosing application", async () => {
  const source = await readFile(
    path.resolve(import.meta.dirname, "internal-tun-alpha-package.ts"),
    "utf8",
  );
  const normalizedSource = source.replace(/\s+/g, " ");
  for (const requirement of [
    "CARGO_INCREMENTAL",
    "--remap-path-prefix=${repositoryRoot}=.",
    "--remap-path-prefix=${process.env.HOME}=~",
    "SOURCE_DATE_EPOCH",
    "Contents/Resources/internal-tun-alpha",
    "Contents/_CodeSignature/CodeResources",
    "await mkdir(packageRoot, { recursive: true, mode: 0o755 })",
    "MISH_MACOS_APP_PATH: application",
    'signAdHoc(application, "com.asuka109.mish")',
    "package root contains unexpected installation items",
  ]) {
    assert.ok(normalizedSource.includes(requirement), `Missing package boundary: ${requirement}`);
  }
  for (const removedRootItem of [
    "Install Internal TUN Alpha.command",
    "Repair Internal TUN Alpha.command",
    "Uninstall Internal TUN Alpha.command",
  ]) {
    assert.equal(
      source.includes(removedRootItem),
      false,
      `Unexpected root item: ${removedRootItem}`,
    );
  }
  const firstApplicationSeal = source.indexOf('signAdHoc(application, "com.asuka109.mish")');
  const manifestCreation = source.indexOf("const manifest = await createInternalTunAlphaManifest");
  const finalApplicationSeal = source.indexOf(
    'signAdHoc(application, "com.asuka109.mish")',
    firstApplicationSeal + 1,
  );
  assert.ok(
    firstApplicationSeal >= 0 &&
      firstApplicationSeal < manifestCreation &&
      manifestCreation < finalApplicationSeal,
    "The manifest must hash the first sealed app and be included in the final app seal",
  );
  const downloadSource = await readFile(
    path.resolve(import.meta.dirname, "development-mihomo.ts"),
    "utf8",
  );
  for (const requirement of [
    "downloadPinnedReleaseArchive",
    "https://github.com/${release.repository}/releases/download/",
    "release.archiveSha256",
    "maximumArchiveBytes",
  ]) {
    assert.ok(
      downloadSource.includes(requirement),
      `Missing credential-free pinned Core boundary: ${requirement}`,
    );
  }
  assert.equal(downloadSource.includes('execFileSync("gh"'), false);
});

test("rejects profile drift, unknown fields, mutable policy, and stale hashes", async () => {
  for (const mutate of [
    (manifest: Record<string, unknown>) => {
      manifest.profile = "alpha-ad-hoc";
    },
    (manifest: Record<string, unknown>) => {
      manifest.allowTun = false;
    },
    (manifest: Record<string, unknown>) => {
      manifest.networkMutationEnabled = false;
    },
    (manifest: Record<string, unknown>) => {
      manifest.developerIdRequired = true;
    },
    (manifest: Record<string, unknown>) => {
      manifest.coreVersion = "latest";
    },
    (manifest: Record<string, unknown>) => {
      manifest.helperVersion = "";
    },
    (manifest: Record<string, unknown>) => {
      manifest.protocolVersion = 4;
    },
    (manifest: Record<string, unknown>) => {
      manifest.installationIdentityScheme = "mutable-path-v0";
    },
    (manifest: Record<string, unknown>) => {
      manifest.unbounded = "rejected";
    },
    (manifest: Record<string, unknown>) => {
      const files = manifest.files as Array<Record<string, unknown>>;
      files[0].sha256 = "0".repeat(64);
    },
  ]) {
    await withFixture(async ({ manifest, manifestFile, verify }) => {
      mutate(manifest as unknown as Record<string, unknown>);
      await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
      await assert.rejects(verify());
    });
  }
});

test("rejects root clutter, links, loose modes, and unexpected payload artifacts", async () => {
  await withFixture(async ({ root, verify }) => {
    await writeFile(path.join(root, "README.txt"), "forbidden\n");
    await assert.rejects(verify(), /root contains unexpected installation items/iu);
  });
  await withFixture(async ({ application, verify }) => {
    await symlink("mihomo", path.join(application, payload, "foreign-link"));
    await assert.rejects(verify(), /symlink|unexpected/iu);
  });
  await withFixture(async ({ application, verify }) => {
    await link(
      path.join(application, payload, "mihomo"),
      path.join(application, payload, "duplicate-core"),
    );
    await assert.rejects(verify(), /metadata|unexpected/iu);
  });
  await withFixture(async ({ application, verify }) => {
    await chmod(path.join(application, payload, "mish-tun-helper"), 0o777);
    await assert.rejects(verify(), /metadata/iu);
  });
  await withFixture(async ({ application, verify }) => {
    await chmod(path.join(application, payload), 0o775);
    await assert.rejects(verify(), /metadata/iu);
  });
  for (const relative of [
    "Contents/Resources/foreign",
    `${payload}/foreign`,
    "Contents/Library/LaunchDaemons/production.plist",
  ]) {
    await withFixture(async ({ application, verify }) => {
      await mkdir(path.dirname(path.join(application, relative)), { recursive: true });
      await writeFile(path.join(application, relative), "forbidden\n");
      await assert.rejects(verify(), /unexpected/iu);
    });
  }
});

test("rejects duplicate manifest entries and unbounded manifest input", async () => {
  await withFixture(async ({ manifest, manifestFile, verify }) => {
    manifest.files[1] = { ...manifest.files[0] };
    await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(verify(), /contract|duplicate/iu);
  });
  await withFixture(async ({ manifest, manifestFile, verify }) => {
    const bytes = `${JSON.stringify(manifest)}${" ".repeat(1024 * 1024)}\n`;
    await writeFile(manifestFile, bytes);
    assert.ok((await readFile(manifestFile)).length > 1024 * 1024);
    await assert.rejects(verify(), /size/iu);
  });
});
