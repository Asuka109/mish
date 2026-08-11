import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempDisposableSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPrivateNoFollowRoot,
  readContainedReleaseFile,
  ReleasePathError,
  writeContainedReleaseFile,
} from "./release-path-containment.ts";

function fixtureRoot(prefix: string) {
  return mkdtempDisposableSync(path.join(tmpdir(), `mish-${prefix}-`));
}

function assertClassification(operation: () => unknown, classification: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof ReleasePathError);
    assert.equal(error.classification, classification);
    assert.doesNotMatch(error.message, /\/tmp|outside|candidate|secret/u);
    return true;
  });
}

test("contains CFBundleExecutable under a private no-follow bundle root", () => {
  using temporary = fixtureRoot("bundle");
  const application = path.join(temporary.path, "Mish.app");
  const executable = path.join(application, "Contents/MacOS/mish-desktop");
  mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
  writeFileSync(executable, "synthetic executable\n", { mode: 0o700 });

  const root = assertPrivateNoFollowRoot(application);
  const guarded = root.contain("Contents/MacOS/mish-desktop", "executable");
  assert.equal(guarded.relative, "Contents/MacOS/mish-desktop");
  assert.equal(readContainedReleaseFile(guarded).toString(), "synthetic executable\n");
});

test("rejects absolute and relative path escapes before touching the bundle", () => {
  using temporary = fixtureRoot("escape");
  const application = path.join(temporary.path, "Mish.app");
  mkdirSync(application, { mode: 0o700 });
  const root = assertPrivateNoFollowRoot(application);

  assertClassification(() => root.contain("/tmp/outside", "file"), "absolute-path");
  assertClassification(() => root.contain("../outside", "file"), "relative-escape");
  assertClassification(() => root.contain("Contents/../../outside", "file"), "relative-escape");
  assertClassification(() => root.contain("..\\outside", "file"), "relative-escape");
  assertClassification(() => root.contain("C:outside", "file"), "absolute-path");
});

test("rejects symlink roots, symlink components, and hard-link substitutions", () => {
  using temporary = fixtureRoot("links");
  const application = path.join(temporary.path, "Mish.app");
  mkdirSync(application, { mode: 0o700 });
  writeFileSync(path.join(application, "real"), "fixture\n", { mode: 0o600 });
  symlinkSync(application, path.join(temporary.path, "Mish-link.app"));
  assertClassification(
    () => assertPrivateNoFollowRoot(path.join(temporary.path, "Mish-link.app")),
    "symlink",
  );

  const linkedDirectory = path.join(application, "Contents");
  mkdirSync(linkedDirectory, { mode: 0o700 });
  writeFileSync(path.join(linkedDirectory, "target"), "target\n", { mode: 0o600 });
  symlinkSync(path.join(linkedDirectory, "target"), path.join(linkedDirectory, "alias"));
  const root = assertPrivateNoFollowRoot(application);
  assertClassification(() => root.contain("Contents/alias", "file"), "symlink");

  linkSync(path.join(application, "real"), path.join(linkedDirectory, "hard-link"));
  assertClassification(() => root.contain("Contents/hard-link", "file"), "hard link");
});

test("rejects non-private roots and non-regular executable targets", () => {
  using temporary = fixtureRoot("metadata");
  const writableRoot = path.join(temporary.path, "writable");
  mkdirSync(writableRoot, { mode: 0o700 });
  chmodSync(writableRoot, 0o777);
  assertClassification(() => assertPrivateNoFollowRoot(writableRoot), "untrusted-root");

  const application = path.join(temporary.path, "Mish.app");
  mkdirSync(path.join(application, "Contents/MacOS"), { recursive: true, mode: 0o700 });
  const root = assertPrivateNoFollowRoot(application);
  writeFileSync(path.join(application, "Contents/MacOS/not-executable"), "fixture\n", {
    mode: 0o600,
  });
  assertClassification(
    () => root.contain("Contents/MacOS/not-executable", "executable"),
    "non-regular",
  );
  mkdirSync(path.join(application, "Contents/MacOS/directory"), { mode: 0o700 });
  assertClassification(() => root.contain("Contents/MacOS/directory", "file"), "non-regular");
});

test("writes regular files only through the guarded root", () => {
  using temporary = fixtureRoot("writes");
  const application = path.join(temporary.path, "Mish.app");
  mkdirSync(path.join(application, "Contents"), { recursive: true, mode: 0o700 });
  const root = assertPrivateNoFollowRoot(application);
  const created = writeContainedReleaseFile(
    root,
    "Contents/metadata.json",
    '{"synthetic":true}\n',
    { mode: 0o644 },
  );
  assert.equal(readContainedReleaseFile(created).toString(), '{"synthetic":true}\n');
  assert.equal(statSync(created.absolute).mode & 0o777, 0o644);

  const overwritten = writeContainedReleaseFile(root, "Contents/metadata.json", "updated\n", {
    mode: 0o600,
    overwrite: true,
  });
  assert.equal(readContainedReleaseFile(overwritten).toString(), "updated\n");
  assert.equal(statSync(overwritten.absolute).mode & 0o777, 0o600);

  const outside = path.join(temporary.path, "outside");
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, path.join(application, "linked"));
  assertClassification(
    () => writeContainedReleaseFile(root, "linked/output", "escape\n"),
    "symlink",
  );

  writeFileSync(path.join(application, "hard-target"), "target\n", { mode: 0o600 });
  linkSync(path.join(application, "hard-target"), path.join(application, "hard-link"));
  assertClassification(
    () => writeContainedReleaseFile(root, "hard-link", "escape\n", { overwrite: true }),
    "hard link",
  );
});

test("rejects a path that is replaced after admission", () => {
  using temporary = fixtureRoot("replacement");
  const application = path.join(temporary.path, "Mish.app");
  mkdirSync(application, { mode: 0o700 });
  const target = path.join(application, "candidate");
  writeFileSync(target, "first\n", { mode: 0o600 });
  const root = assertPrivateNoFollowRoot(application);
  const guarded = root.contain("candidate", "file");

  const moved = path.join(temporary.path, "moved");
  renameSync(target, moved);
  writeFileSync(target, "replacement\n", { mode: 0o600 });
  assertClassification(() => guarded.assertCurrent(), "replaced");
});
