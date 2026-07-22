import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { Resvg } from "@resvg/resvg-js";

const BLUE = "#2F6FDC";
const INACTIVE_STATUS_BAR_ALPHA = 0.45;
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const brandDirectory = join(repositoryRoot, "packages/brand-assets/public/brand");
const outlineSvgPath = join(brandDirectory, "mish-icon-outline.svg");
const sourceIconPath = join(brandDirectory, "mish-app-icon.png");
const generatedDirectory = join(repositoryRoot, "packages/brand-assets/generated/tauri");
const generatedStatusBarDirectory = join(
  repositoryRoot,
  "packages/brand-assets/generated/status-bar",
);
const androidResourcesDirectory = join(
  repositoryRoot,
  "apps/mobile/src-tauri/gen/android/app/src/main/res",
);

const outlineSvg = readFileSync(outlineSvgPath, "utf8");
const markPathData = outlineSvg.match(/<path\s+[^>]*d="([^"]+)"/)?.[1];

if (!markPathData) {
  throw new Error(`Could not read the canonical mark path from ${outlineSvgPath}`);
}

function markPath({
  color = BLUE,
  transform = "translate(202 145)",
}: {
  color?: string;
  transform?: string;
} = {}) {
  return `<path d="${markPathData}" fill="${color}" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" transform="${transform}"/>`;
}

function appIconSvg({ dark }: { dark: boolean }) {
  const suffix = dark ? " (dark)" : "";
  const gradientStart = dark ? "#1D2431" : "#FFFFFF";
  const gradientMiddle = dark ? "#171D29" : "#FAFCFF";
  const gradientEnd = dark ? "#111620" : "#EEF3FA";
  const border = dark ? "#30394A" : "#E1E7F0";
  const shadow = dark ? "#05070C" : "#18243A";

  return `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="title">
  <title id="title">Mish app icon${suffix}</title>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${gradientStart}"/>
      <stop offset="0.58" stop-color="${gradientMiddle}"/>
      <stop offset="1" stop-color="${gradientEnd}"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="${shadow}" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect x="76" y="64" width="872" height="872" rx="204" fill="url(#background)" stroke="${border}" stroke-width="2" filter="url(#shadow)"/>
  <g transform="translate(128 128) scale(1.5)">
    ${markPath()}
  </g>
</svg>
`;
}

function statusBarSvg({ color, title }: { color: string; title: string }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title">
  <title id="title">${title}</title>
  ${markPath({ color })}
</svg>
`;
}

function syncWordmarkMark(filename: string) {
  const path = join(brandDirectory, filename);
  const svg = readFileSync(path, "utf8");
  const markGroup = `<g transform="translate(-19 -60)">${markPath()}</g>`;
  const synchronized = svg.replace(/<g transform="translate\(-19 -60\)">.*?<\/g>/s, markGroup);

  if (synchronized === svg && !svg.includes(markPathData)) {
    throw new Error(`Could not synchronize the mark in ${path}`);
  }
  writeFileSync(path, synchronized);
}

function renderSvg(filename: string, outputFilename: string, width: number) {
  const svg = readFileSync(join(brandDirectory, filename));
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
  }).render();
  writeFileSync(join(brandDirectory, outputFilename), rendered.asPng());
  return rendered.pixels;
}

function statusBarTemplatePixels(opacity: number) {
  const rendered = new Resvg(
    statusBarSvg({ color: "#000000", title: "Mish internal status bar template mask" }),
    { fitTo: { mode: "width", value: 36 } },
  ).render().pixels;
  const mask = new Uint8Array(rendered.length);
  for (let index = 0; index < rendered.length; index += 4) {
    const alpha = rendered[index + 3];
    mask[index + 3] = alpha === 0 ? 0 : Math.max(1, Math.round(alpha * opacity));
  }
  return mask;
}

function generateTauriIcons(extraArguments: string[] = []) {
  const result = spawnSync(
    "pnpm",
    [
      "--dir",
      join(repositoryRoot, "apps/mobile"),
      "exec",
      "tauri",
      "icon",
      sourceIconPath,
      "--output",
      generatedDirectory,
      ...extraArguments,
    ],
    { stdio: "inherit" },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function synchronizeTauriIcons() {
  const fingerprintPath = join(generatedDirectory, ".source-sha256");
  const fingerprint = createHash("sha256")
    .update("mish-tauri-icons-v1\0")
    .update(readFileSync(sourceIconPath))
    .digest("hex");
  const currentFingerprint = existsSync(fingerprintPath)
    ? readFileSync(fingerprintPath, "utf8").trim()
    : undefined;

  if (currentFingerprint === fingerprint && !process.argv.includes("--force-tauri")) {
    return;
  }

  generateTauriIcons();
  generateTauriIcons(["--png", "32,180,192,512"]);
  writeFileSync(fingerprintPath, `${fingerprint}\n`);
}

writeFileSync(
  join(brandDirectory, "mish-icon-outline-dark.svg"),
  outlineSvg.replace("Mish outline icon", "Mish outline icon (dark)"),
);
writeFileSync(join(brandDirectory, "mish-app-icon.svg"), appIconSvg({ dark: false }));
writeFileSync(join(brandDirectory, "mish-app-icon-dark.svg"), appIconSvg({ dark: true }));
writeFileSync(
  join(brandDirectory, "mish-status-bar-full.svg"),
  statusBarSvg({ color: "#FFFFFF", title: "Mish status bar icon (full prominence)" }),
);
writeFileSync(
  join(brandDirectory, "mish-status-bar-inactive.svg"),
  statusBarSvg({ color: "#8A8A8A", title: "Mish status bar icon (inactive)" }),
);

syncWordmarkMark("mish-brand.svg");
syncWordmarkMark("mish-brand-dark.svg");

renderSvg("mish-icon-outline.svg", "mish-icon-outline.png", 512);
renderSvg("mish-icon-outline-dark.svg", "mish-icon-outline-dark.png", 512);
renderSvg("mish-brand.svg", "mish-brand.png", 1349);
renderSvg("mish-brand-dark.svg", "mish-brand-dark.png", 1349);
renderSvg("mish-app-icon.svg", "mish-app-icon.png", 1024);
renderSvg("mish-app-icon-dark.svg", "mish-app-icon-dark.png", 1024);

for (const size of [32, 180, 192, 512]) {
  renderSvg("mish-app-icon.svg", `mish-app-icon-${size}.png`, size);
  renderSvg("mish-app-icon-dark.svg", `mish-app-icon-dark-${size}.png`, size);
}

for (const size of [18, 36]) {
  const suffix = size === 18 ? "" : "@2x";
  renderSvg("mish-status-bar-full.svg", `mish-status-bar-full${suffix}.png`, size);
  renderSvg("mish-status-bar-inactive.svg", `mish-status-bar-inactive${suffix}.png`, size);
}

mkdirSync(generatedStatusBarDirectory, { recursive: true });
writeFileSync(
  join(generatedStatusBarDirectory, "mish-status-bar-active.rgba"),
  statusBarTemplatePixels(1),
);
writeFileSync(
  join(generatedStatusBarDirectory, "mish-status-bar-inactive.rgba"),
  statusBarTemplatePixels(INACTIVE_STATUS_BAR_ALPHA),
);

synchronizeTauriIcons();

for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
  const destination = join(androidResourcesDirectory, `mipmap-${density}`);
  mkdirSync(destination, { recursive: true });
  cpSync(join(generatedDirectory, "android", `mipmap-${density}`), destination, {
    recursive: true,
  });
}

const adaptiveIconDirectory = join(androidResourcesDirectory, "mipmap-anydpi-v26");
mkdirSync(adaptiveIconDirectory, { recursive: true });
cpSync(
  join(generatedDirectory, "android/mipmap-anydpi-v26/ic_launcher.xml"),
  join(adaptiveIconDirectory, "ic_launcher.xml"),
);
cpSync(
  join(generatedDirectory, "android/values/ic_launcher_background.xml"),
  join(androidResourcesDirectory, "values/ic_launcher_background.xml"),
);

console.log("Generated and synchronized shared Web, desktop, mobile, and status bar icons.");
