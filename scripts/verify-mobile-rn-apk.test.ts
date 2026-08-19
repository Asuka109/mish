import assert from "node:assert/strict";
import test from "node:test";
import {
  parseManifestPermissions,
  parseNativeAbis,
  parsePackageName,
} from "./verify-mobile-rn-apk.ts";

test("parses one closed package identity and INTERNET-only permission", () => {
  const output =
    "package: name='com.asuka109.mish.rn' versionCode='1' versionName='0.1.0'\n" +
    "uses-permission: name='android.permission.INTERNET'\n";
  assert.equal(parsePackageName(output), "com.asuka109.mish.rn");
  assert.deepEqual(parseManifestPermissions(output), ["android.permission.INTERNET"]);
});

test("parses one ABI from an APK listing and rejects multiple package records", () => {
  assert.deepEqual(
    parseNativeAbis("lib/arm64-v8a/libhermes.so\nlib/arm64-v8a/libreactnative.so\n"),
    ["arm64-v8a"],
  );
  assert.throws(
    () => parsePackageName("package: name='com.asuka109.mish.rn'\npackage: name='foreign.app'\n"),
    /multiple package names/u,
  );
});

test("keeps malformed and unbounded inspection output fail-closed", () => {
  assert.throws(() => parsePackageName("not badging"), /package name/u);
  assert.throws(() => parseNativeAbis("x".repeat(128 * 1024 + 1)), /bounded limit/u);
});
