---
name: macos-dmg-packaging
description: Build, modify, review, or debug Mish macOS DMG installers, including the Finder window, .DS_Store icon layout, custom background PNG/SVG, Applications alias, template volume, DMG assembly, and visual verification. Use for any change to resources/macos-dmg, scripts/macos-dmg-presentation.ts, macOS packaging docs, or a user report that the DMG is blurry, clipped, misaligned, cached, too large, or visually inconsistent.
---

# Mish macOS DMG Packaging

Treat the installer as three coupled artifacts: the background image, the
Finder template (including `.DS_Store`), and the assembled delivery DMG. A
change is incomplete until the final read-only DMG is checked through Finder;
passing a JSON or binary-hash test alone is not sufficient.

## Read before editing

From the repository root, inspect:

- `resources/macos-dmg/presentation.json` — the visual contract and asset hashes.
- `resources/macos-dmg/mish-install.svg` and `mish-install.png` — approved artwork.
- `resources/macos-dmg/mish-installer-template.dmg` — the real Finder template;
  its `.DS_Store` stores window and icon presentation.
- `scripts/macos-dmg-presentation.ts` — assembly and read-only verification.
- `scripts/macos-dmg-presentation.test.ts` — contract, root-entry, and assembly tests.
- `docs/operations/macos-packaging.md` — packaging and evidence boundary.

Do not edit only `presentation.json`. If window or icon values change, rebuild
the template, verify the persisted Finder metadata, then update the template
and `.DS_Store` hashes together.

## Approval gate for background artwork

When creating or materially changing the background:

1. Generate original artwork; do not copy the reference DMG image.
2. Prefer a simple vector SVG rendered to PNG to avoid moiré or resampling
   artifacts. Keep the gradient restrained and the arrow geometrically simple.
3. Review the candidate before placing it in the template. Check pixel size,
   color type, dpi, arrow bounds, and that the arrow is not hidden by either
   icon. If the user has not approved the candidate, show it and stop before
   replacing the packaged asset.
4. For the current Mish contract, preserve `1080×760`, 8-bit RGB, and `144 dpi`
   unless the user explicitly approves a different layout. This is a 2× logical
   canvas and 4× the pixels of the 540×380 Finder window.

## Rebuild the Finder template safely

Use a clean writable HFS+ image or deliberately refresh the existing template;
do not rely on a previously mounted volume or a same-named Finder window.

1. Put only `.background`, an empty `Mish.app` placeholder, and the
   `/Applications` symlink in the template root.
2. Open the writable image in Finder and set the window, icon size, text size,
   arrangement, background picture, and both item positions.
3. Close the Finder window before detaching. Do not copy the template after an
   AppleScript error or partial verification.
4. Detach it, compress it to the repository template path, and update both
   template hashes in `presentation.json`.
5. Reattach the compressed template read-only and verify that Finder persisted
   the values. If the values change after reattach, rebuild it again.

If Finder appears to reuse an old view, eject every temporary DMG volume first,
then rebuild from a clean HFS+ volume. A new HFS volume identity can help
invalidate stale Finder state, but it does not replace read-back verification.
If deterministic HFS normalization uses a versioned fixed volume ID, bump that
version only as an intentional cache invalidation and regenerate the fixture.

## Current presentation contract

Unless the user explicitly approves a different design, verify these values:

```text
window bounds:       {180,160,720,540}   # 540×380 points
arrangement:         not arranged
icon size:           80
text size:           13
Mish.app position:   {140,190}
Applications:        {410,190}
```

The visible root must contain only `Mish.app` and `Applications`; the
`Applications` entry must be a symlink to `/Applications`. Hidden support files
are `.DS_Store` and `.background`.

## Verify at the same layer as the user

Run the narrow checks first:

```sh
git diff --check
pnpm exec oxfmt --check scripts/macos-dmg-presentation.test.ts
node --test --test-reporter=spec scripts/macos-dmg-presentation.test.ts
```

Build a disposable preview with `createMacOsDmg(...,
{ replaceExistingOutput: true })`, then call
`verifyMacOsDmgPresentation` on that exact output. Mount the final DMG
read-only and use Finder/AppleScript to read, not merely set:

- window bounds;
- `not arranged`, icon size, and text size;
- `position of item "Mish.app"`;
- `position of item "Applications"`.

Use explicit AppleScript text delimiters when logging point lists, otherwise
`{140,190}` can appear as the misleading string `140190`. A successful check
must report the exact contract values above. Also run `sips -g pixelWidth
-g pixelHeight -g dpiWidth -g dpiHeight` on the mounted background and list the
template root entries.

Use this read-back shape against the mounted DMG; do not treat the setter call
as evidence that the values persisted:

```sh
osascript - "$MOUNT" <<'APPLESCRIPT'
on run argv
  set mountPath to item 1 of argv
  tell application "Finder"
    set targetFolder to POSIX file mountPath as alias
    open targetFolder
    delay 1
    set targetWindow to front window
    set viewOptions to icon view options of targetWindow
    set AppleScript's text item delimiters to ","
    set resultText to "bounds=" & ((bounds of targetWindow) as text) & ", arrangement=" & ((arrangement of viewOptions) as text) & ", iconSize=" & ((icon size of viewOptions) as text) & ", textSize=" & ((text size of viewOptions) as text) & ", Mish=" & ((position of item "Mish.app" of targetFolder) as text) & ", Applications=" & ((position of item "Applications" of targetFolder) as text)
    close targetWindow
    return resultText
  end tell
end run
APPLESCRIPT
```

The routine assembler must remain Finder-free; keep `open`/Finder operations in
an explicit macOS visual-verification step. Any mount, detach, AppleScript, or
read-back error is a delivery blocker. Eject all disposable volumes before
handoff so the user does not open a stale same-named volume.

## Handoff requirements

Report the exact preview or release DMG path, the measured Finder values, the
background dimensions/dpi, the tests run, and any unsupported claim. Preserve
unrelated worktree changes and do not stage them accidentally.
