import assert from "node:assert/strict";
import test from "node:test";
import {
  readProfilePatchEditorSources,
  validateProfilePatchEditorRemoval,
} from "./check-profile-patch-editor-removal.ts";

function repositoryFixture(): Record<string, string | undefined> {
  return readProfilePatchEditorSources();
}

function expectFailure(sources: Record<string, string | undefined>, expected: RegExp): void {
  const failures = validateProfilePatchEditorRemoval(sources).join("\n");
  assert.match(failures, expected);
}

test("the repository is a clean positive Profile Patch Editor removal fixture", () => {
  assert.deepEqual(validateProfilePatchEditorRemoval(repositoryFixture()), []);
});

test("active Profile patch persistence remains allowed by the deletion gate", () => {
  const fixture = repositoryFixture();
  fixture["crates/profile/src/patch.rs"] +=
    "\n// Active ProfilePatchSet persistence and runtime application remain supported.\n";
  fixture["apps/web/src/pages/profiles-page.tsx"] +=
    "\n// Active import, save, cancel, and discard journey remains supported.\n";
  assert.deepEqual(validateProfilePatchEditorRemoval(fixture), []);
});

test("a dangling Profile Patch Editor route fails closed", () => {
  const fixture = repositoryFixture();
  fixture["apps/web/src/app-routes.tsx"] +=
    '\n<Route path="profiles/patch-editor" element={<ProfilePage />} />\n';
  expectFailure(fixture, /removed Profile Patch Editor route/u);
});

test("a dangling Profile Patch Editor import fails closed", () => {
  const fixture = repositoryFixture();
  fixture["apps/web/src/pages/profiles-page.tsx"] +=
    '\nconst loadRemovedEditor = () => import("../components/profile-patch-editor");\n';
  expectFailure(fixture, /dangling Profile Patch Editor import/u);
});

test("a reintroduced public bridge method fails closed", () => {
  const fixture = repositoryFixture();
  fixture["packages/bridge-protocol/bridge-protocol.json"] +=
    "\n// profiles.getPatches must remain retired.\n";
  expectFailure(fixture, /removed Profile Patch Editor marker profiles\.getPatches/u);
});

test("a reintroduced localization key fails closed", () => {
  const fixture = repositoryFixture();
  fixture["apps/web/src/i18n/en/index.ts"] += '\n    patchEdit: "Edit rules",\n';
  expectFailure(fixture, /removed Profile localization key patchEdit/u);
});

test("the retired Profile patches key is rejected while generic patch counts stay allowed", () => {
  const fixture = repositoryFixture();
  fixture["apps/web/src/i18n/en/index.ts"] = fixture["apps/web/src/i18n/en/index.ts"]!.replace(
    "    saveProfile:",
    '    patches: "Retired editor patches",\n    saveProfile:',
  );
  expectFailure(fixture, /removed Profile localization key patches/u);
});

test("a reintroduced generated contract token fails closed", () => {
  const fixture = repositoryFixture();
  fixture["packages/contracts/src/generated/bridge-protocol.ts"] +=
    "\n// profiles.replacePatches must not return to generated bindings.\n";
  expectFailure(fixture, /removed Profile Patch Editor marker profiles\.replacePatches/u);
});

test("a production entry importing a test fixture fails the exclusion gate", () => {
  const fixture = repositoryFixture();
  fixture["apps/web/src/main.tsx"] += '\nimport "./pages/profiles-page.test";\n';
  expectFailure(fixture, /production Web graph reaches test-only source/u);
});
