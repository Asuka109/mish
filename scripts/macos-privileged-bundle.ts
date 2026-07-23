import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const productionHelperRelativePath = "Contents/Resources/mish-tun-helper";
export const productionPlistRelativePath =
  "Contents/Library/LaunchDaemons/com.asuka109.mish.tun-helper.plist";

export type MacOsPrivilegedBundleMode = "ad-hoc" | "production";

async function digest(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function walk(root: string, directory = root): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const discovered = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) return [relative, ...(await walk(root, absolute))];
      return [relative];
    }),
  );
  return discovered.flat().sort();
}

async function requireDirectory(directory: string) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Privileged bundle directory is not a real directory: ${directory}`);
  }
  if (metadata.mode & 0o022) {
    throw new Error(`Privileged bundle directory is group- or world-writable: ${directory}`);
  }
}

async function requireRegularFile(file: string, executable: boolean) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Privileged bundle artifact is not a regular file: ${file}`);
  }
  if (metadata.nlink !== 1) {
    throw new Error(`Privileged bundle artifact has duplicate hard links: ${file}`);
  }
  if (metadata.mode & 0o022) {
    throw new Error(`Privileged bundle artifact is group- or world-writable: ${file}`);
  }
  if (executable !== Boolean(metadata.mode & 0o111)) {
    throw new Error(`Privileged bundle artifact has unexpected executable permissions: ${file}`);
  }
}

function isPrivilegedPath(relative: string) {
  const components = relative.split(path.sep);
  const basename = components.at(-1) ?? "";
  return (
    components.includes("Library") ||
    components.includes("LaunchDaemons") ||
    components.includes("LaunchAgents") ||
    components.includes("PrivilegedHelperTools") ||
    components.includes("XPCServices") ||
    components.includes("LoginItems") ||
    /(?:^|[-_.])(?:tun|helper|smappservice|launchdaemon)(?:$|[-_.])/iu.test(basename)
  );
}

export async function verifyMacOsPrivilegedBundle(
  application: string,
  mode: MacOsPrivilegedBundleMode,
) {
  const expected = new Set([productionHelperRelativePath, productionPlistRelativePath]);
  const discovered = await walk(application);
  const privileged = discovered.filter(isPrivilegedPath);

  if (mode === "ad-hoc") {
    if (privileged.length > 0) {
      throw new Error(`Ad-hoc bundle contains privileged artifacts: ${privileged.join(", ")}`);
    }
    return;
  }

  for (const required of expected) {
    if (!discovered.includes(required)) {
      throw new Error(`Production bundle is missing privileged artifact: ${required}`);
    }
  }
  const unexpected = privileged.filter(
    (relative) =>
      !expected.has(relative) &&
      relative !== "Contents/Library" &&
      relative !== "Contents/Library/LaunchDaemons",
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Production bundle contains unexpected privileged artifacts: ${unexpected.join(", ")}`,
    );
  }

  const helper = path.join(application, productionHelperRelativePath);
  const plist = path.join(application, productionPlistRelativePath);
  await requireDirectory(path.dirname(plist));
  await requireRegularFile(helper, true);
  await requireRegularFile(plist, false);
  const sourcePlist = path.resolve(
    "apps/desktop/src-tauri/macos/LaunchDaemons/com.asuka109.mish.tun-helper.plist",
  );
  if ((await digest(plist)) !== (await digest(sourcePlist))) {
    throw new Error("Bundled LaunchDaemon property list does not match the repository contract");
  }

  for (const relative of discovered) {
    const metadata = await lstat(path.join(application, relative));
    if (metadata.isFile() && metadata.mode & 0o6000) {
      throw new Error(`Production bundle contains a set-id artifact: ${relative}`);
    }
  }
}
