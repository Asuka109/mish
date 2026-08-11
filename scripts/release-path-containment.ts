import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const releasePathRejections = [
  "absolute-path",
  "relative-escape",
  "missing",
  "symlink",
  "hard link",
  "non-regular",
  "untrusted-root",
  "writable",
  "replaced",
  "io",
] as const;

export type ReleasePathRejection = (typeof releasePathRejections)[number];
export type ReleasePathKind = "directory" | "file" | "executable";

interface ReleasePathIdentity {
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  nlink: number;
  size: number;
}

interface ReleasePathObservation {
  contentSensitive: boolean;
  identity: ReleasePathIdentity;
  pathname: string;
}

export interface ContainedReleasePath {
  readonly absolute: string;
  readonly kind: ReleasePathKind;
  readonly relative: string;
  assertCurrent(): void;
  assertLocationCurrent(): void;
}

export interface PrivateNoFollowRoot {
  readonly absolute: string;
  assertCurrent(): void;
  contain(relative: string, kind: ReleasePathKind): ContainedReleasePath;
}

export class ReleasePathError extends Error {
  readonly classification: ReleasePathRejection;

  constructor(classification: ReleasePathRejection) {
    super(`release-path-rejected:${classification}`);
    this.name = "ReleasePathError";
    this.classification = classification;
  }
}

function reject(classification: ReleasePathRejection): never {
  throw new ReleasePathError(classification);
}

function isPathError(error: unknown): error is ReleasePathError {
  return error instanceof ReleasePathError;
}

function inspect(pathname: string): {
  identity: ReleasePathIdentity;
  metadata: ReturnType<typeof lstatSync>;
} {
  try {
    const metadata = lstatSync(pathname);
    return {
      identity: {
        dev: metadata.dev,
        ino: metadata.ino,
        mode: metadata.mode,
        mtimeMs: metadata.mtimeMs,
        nlink: metadata.nlink,
        size: metadata.size,
      },
      metadata,
    };
  } catch {
    reject("missing");
  }
}

function sameIdentity(left: ReleasePathIdentity, right: ReleasePathIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function requireAbsolute(pathname: string): string {
  if (
    !path.isAbsolute(pathname) ||
    /^[A-Za-z]:[\\/]/u.test(pathname) ||
    pathname.startsWith("\\\\")
  ) {
    reject("absolute-path");
  }
  return path.resolve(pathname);
}

function requireRelative(relative: string): string {
  if (
    relative.length === 0 ||
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    /^[A-Za-z]:/u.test(relative) ||
    relative.startsWith("/") ||
    relative.startsWith("\\")
  ) {
    reject("absolute-path");
  }
  const components = relative.split(/[\\/]/u);
  if (
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  ) {
    reject("relative-escape");
  }
  return components.join(path.sep);
}

function currentUid(): number | undefined {
  return process.getuid?.();
}

function validateRootMetadata(metadata: ReturnType<typeof lstatSync>): void {
  if (metadata.isSymbolicLink()) reject("symlink");
  if (!metadata.isDirectory()) reject("non-regular");
  if ((metadata.mode & 0o022) !== 0) reject("untrusted-root");
  const uid = currentUid();
  if (uid !== undefined && metadata.uid !== uid) reject("untrusted-root");
}

function validateDirectoryMetadata(metadata: ReturnType<typeof lstatSync>): void {
  if (metadata.isSymbolicLink()) reject("symlink");
  if (!metadata.isDirectory()) reject("non-regular");
  if ((metadata.mode & 0o022) !== 0) reject("writable");
}

function validateFileMetadata(
  metadata: ReturnType<typeof lstatSync>,
  kind: Extract<ReleasePathKind, "file" | "executable">,
): void {
  if (metadata.isSymbolicLink()) reject("symlink");
  if (!metadata.isFile()) reject("non-regular");
  if (metadata.nlink !== 1) reject("hard link");
  if ((metadata.mode & 0o022) !== 0) reject("writable");
  if (kind === "executable" && (metadata.mode & 0o111) === 0) reject("non-regular");
}

function validatePath(
  root: string,
  relative: string,
  kind: ReleasePathKind,
): { absolute: string; identities: ReleasePathObservation[] } {
  const safeRelative = requireRelative(relative);
  const absolute = path.resolve(root, safeRelative);
  const escaped = path.relative(root, absolute);
  if (
    !escaped ||
    escaped === ".." ||
    escaped.startsWith(`..${path.sep}`) ||
    path.isAbsolute(escaped)
  ) {
    reject("relative-escape");
  }

  const identities: ReleasePathObservation[] = [];
  let current = root;
  const components = safeRelative.split(path.sep);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const inspected = inspect(current);
    if (index < components.length - 1) {
      validateDirectoryMetadata(inspected.metadata);
    } else if (kind === "directory") {
      validateDirectoryMetadata(inspected.metadata);
    } else {
      validateFileMetadata(inspected.metadata, kind);
    }
    identities.push({
      contentSensitive: kind !== "directory" && index === components.length - 1,
      identity: inspected.identity,
      pathname: current,
    });
  }
  return { absolute, identities };
}

function assertIdentities(identities: ReleasePathObservation[]): void {
  for (const { contentSensitive, pathname, identity } of identities) {
    let current: ReturnType<typeof inspect>;
    try {
      current = inspect(pathname);
    } catch (error) {
      if (isPathError(error)) throw error;
      reject("replaced");
    }
    if (
      !sameLocationIdentity(identity, current.identity) ||
      (contentSensitive && !sameIdentity(identity, current.identity))
    ) {
      reject("replaced");
    }
  }
}

function assertLocations(identities: ReleasePathObservation[]): void {
  for (const { pathname, identity } of identities) {
    const current = inspect(pathname);
    if (current.identity.dev !== identity.dev || current.identity.ino !== identity.ino) {
      reject("replaced");
    }
  }
}

function sameLocationIdentity(left: ReleasePathIdentity, right: ReleasePathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function openNoFollow(pathname: string): number {
  try {
    return openSync(pathname, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    reject("io");
  }
}

export function readContainedReleaseFile(path: ContainedReleasePath): Buffer {
  if (path.kind === "directory") reject("non-regular");
  path.assertCurrent();
  const descriptor = openNoFollow(path.absolute);
  try {
    const metadata = fstatSync(descriptor);
    const inspected = inspect(path.absolute);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      !sameIdentity(
        {
          dev: metadata.dev,
          ino: metadata.ino,
          mode: metadata.mode,
          mtimeMs: metadata.mtimeMs,
          nlink: metadata.nlink,
          size: metadata.size,
        },
        inspected.identity,
      )
    ) {
      reject("replaced");
    }
    const contents = readFileSync(descriptor);
    path.assertCurrent();
    return contents;
  } catch (error) {
    if (isPathError(error)) throw error;
    reject("io");
  } finally {
    closeSync(descriptor);
  }
}

export function writeContainedReleaseFile(
  root: PrivateNoFollowRoot,
  relative: string,
  contents: Buffer | string,
  options: { mode?: number; overwrite?: boolean } = {},
): ContainedReleasePath {
  const safeRelative = requireRelative(relative);
  const parent = path.dirname(safeRelative);
  const parentGuard = parent === "." ? undefined : root.contain(parent, "directory");
  let existing: ContainedReleasePath | undefined;
  try {
    existing = root.contain(safeRelative, "file");
  } catch (error) {
    if (!isPathError(error) || error.classification !== "missing") throw error;
  }
  if (existing && !options.overwrite) reject("replaced");
  root.assertCurrent();
  parentGuard?.assertCurrent();
  existing?.assertCurrent();
  const flags =
    constants.O_WRONLY |
    (options.overwrite
      ? constants.O_CREAT | constants.O_TRUNC
      : constants.O_CREAT | constants.O_EXCL) |
    (constants.O_NOFOLLOW ?? 0);
  let descriptor: number;
  try {
    descriptor = openSync(path.join(root.absolute, safeRelative), flags, options.mode ?? 0o600);
  } catch {
    reject("io");
  }
  try {
    if (existing) {
      const metadata = fstatSync(descriptor);
      const inspected = inspect(existing.absolute);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        !sameIdentity(
          {
            dev: metadata.dev,
            ino: metadata.ino,
            mode: metadata.mode,
            mtimeMs: metadata.mtimeMs,
            nlink: metadata.nlink,
            size: metadata.size,
          },
          inspected.identity,
        )
      ) {
        reject("replaced");
      }
    }
    writeFileSync(descriptor, contents);
    if (options.mode !== undefined) fchmodSync(descriptor, options.mode);
  } catch (error) {
    if (isPathError(error)) throw error;
    reject("io");
  } finally {
    closeSync(descriptor);
  }
  root.assertCurrent();
  parentGuard?.assertCurrent();
  existing?.assertLocationCurrent();
  return root.contain(safeRelative, "file");
}

export function assertPrivateNoFollowRoot(root: string): PrivateNoFollowRoot {
  const absolute = requireAbsolute(root);
  const inspected = inspect(absolute);
  validateRootMetadata(inspected.metadata);
  const rootIdentity = inspected.identity;
  return {
    absolute,
    assertCurrent(): void {
      const current = inspect(absolute);
      if (!sameLocationIdentity(rootIdentity, current.identity)) reject("replaced");
      validateRootMetadata(current.metadata);
    },
    contain(relative: string, kind: ReleasePathKind): ContainedReleasePath {
      const result = validatePath(absolute, relative, kind);
      const identities: ReleasePathObservation[] = [
        { contentSensitive: false, pathname: absolute, identity: rootIdentity },
        ...result.identities,
      ];
      return {
        absolute: result.absolute,
        kind,
        relative: relative.split(/[\\/]/u).join("/"),
        assertCurrent(): void {
          assertIdentities(identities);
        },
        assertLocationCurrent(): void {
          assertLocations(identities);
        },
      };
    },
  };
}

export function assertPrivateNoFollowFile(file: string): ContainedReleasePath {
  const absolute = requireAbsolute(file);
  const root = assertPrivateNoFollowRoot(path.dirname(absolute));
  return root.contain(path.basename(absolute), "file");
}
