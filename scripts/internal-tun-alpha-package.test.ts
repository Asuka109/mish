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
  internalTunAlphaManifestName,
  verifyInternalTunAlphaPackage,
} from "./internal-tun-alpha-package.ts";

const fixtureFiles = [
  ["Health Internal TUN Alpha.command", 0o755],
  ["Install Internal TUN Alpha.command", 0o755],
  ["LICENSE", 0o644],
  ["README.txt", 0o644],
  ["Repair Internal TUN Alpha.command", 0o755],
  ["Resources/mish-internal-tun-alpha-ctl", 0o755],
  ["Resources/com.asuka109.mish.tun-helper.dev.plist.template", 0o644],
  ["Resources/mihomo", 0o755],
  ["Resources/mish-tun-helper", 0o755],
  ["Status Internal TUN Alpha.command", 0o755],
  ["THIRD_PARTY_NOTICES.md", 0o644],
  ["Uninstall Internal TUN Alpha.command", 0o755],
] as const;

const template = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.asuka109.mish.tun-helper.dev</string>
<key>ProgramArguments</key><array><string>/Library/PrivilegedHelperTools/com.asuka109.mish.tun-helper.dev</string></array>
<key>EnvironmentVariables</key><dict>
<key>MISH_TUN_SERVICE_ALLOWED_UID</key><string>__MISH_ALLOWED_UID__</string>
<key>MISH_TUN_SERVICE_ALLOW_TUN</key><string>0</string>
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
  await mkdir(path.join(root, "Resources"), { recursive: true, mode: 0o755 });
  await chmod(root, 0o755);
  await chmod(path.join(root, "Resources"), 0o755);
  for (const [relative, mode] of fixtureFiles) {
    const content = relative.endsWith(".plist.template")
      ? template
      : relative.endsWith(".command")
        ? "#!/bin/sh\nexit 0\n"
        : `fixture:${relative}\n`;
    await writeFile(path.join(root, relative), content, { mode });
    await chmod(path.join(root, relative), mode);
  }
  const manifest = await createInternalTunAlphaManifest(root, {
    coreVersion: "v1.19.29",
    helperVersion: "3",
  });
  await writeFile(
    path.join(root, internalTunAlphaManifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  await chmod(path.join(root, internalTunAlphaManifestName), 0o644);
  return {
    manifest,
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

test("accepts only the closed disabled Internal TUN Alpha package", async () => {
  await withFixture(async ({ verify }) => {
    const manifest = await verify();
    assert.equal(manifest.profile, "internal-tun-alpha");
    assert.equal(manifest.allowTun, false);
    assert.equal(manifest.networkMutationEnabled, false);
    assert.equal(manifest.developerIdRequired, false);
    assert.equal(manifest.protocolVersion, 3);
    assert.equal(manifest.files.length, 12);
  });
});

test("rejects profile drift, unknown fields, mutable policy, and stale hashes", async () => {
  for (const mutate of [
    (manifest: Record<string, unknown>) => {
      manifest.profile = "alpha-ad-hoc";
    },
    (manifest: Record<string, unknown>) => {
      manifest.allowTun = true;
    },
    (manifest: Record<string, unknown>) => {
      manifest.networkMutationEnabled = true;
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
    await withFixture(async ({ manifest, root, verify }) => {
      mutate(manifest as unknown as Record<string, unknown>);
      await writeFile(
        path.join(root, internalTunAlphaManifestName),
        `${JSON.stringify(manifest)}\n`,
      );
      await assert.rejects(verify());
    });
  }
});

test("rejects symlinks, hard links, loose modes, and unexpected profile artifacts", async () => {
  await withFixture(async ({ root, verify }) => {
    await symlink("mihomo", path.join(root, "Resources/foreign-link"));
    await assert.rejects(verify(), /symlink|unexpected/iu);
  });
  await withFixture(async ({ root, verify }) => {
    await link(path.join(root, "Resources/mihomo"), path.join(root, "Resources/duplicate-core"));
    await assert.rejects(verify(), /metadata|unexpected/iu);
  });
  await withFixture(async ({ root, verify }) => {
    await chmod(path.join(root, "Install Internal TUN Alpha.command"), 0o777);
    await assert.rejects(verify(), /metadata/iu);
  });
  await withFixture(async ({ root, verify }) => {
    await chmod(path.join(root, "Resources"), 0o775);
    await assert.rejects(verify(), /metadata/iu);
  });
  for (const relative of [
    "Mish.app",
    "Contents/Library/LaunchDaemons/production.plist",
    "Resources/tun-client-key.json",
  ]) {
    await withFixture(async ({ root, verify }) => {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), "forbidden\n");
      await assert.rejects(verify(), /unexpected/iu);
    });
  }
});

test("rejects duplicate manifest entries and unbounded manifest input", async () => {
  await withFixture(async ({ manifest, root, verify }) => {
    manifest.files[1] = { ...manifest.files[0] };
    await writeFile(path.join(root, internalTunAlphaManifestName), `${JSON.stringify(manifest)}\n`);
    await assert.rejects(verify(), /contract/iu);
  });
  await withFixture(async ({ manifest, root, verify }) => {
    const bytes = `${JSON.stringify(manifest)}${" ".repeat(70 * 1024)}\n`;
    await writeFile(path.join(root, internalTunAlphaManifestName), bytes);
    assert.ok((await readFile(path.join(root, internalTunAlphaManifestName))).length > 64 * 1024);
    await assert.rejects(verify(), /size/iu);
  });
});
