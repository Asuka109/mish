import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceIcon = join(repositoryRoot, "packages/brand-assets/public/brand/mish-app-icon.png");
const generatedDirectory = join(repositoryRoot, "packages/brand-assets/generated/tauri");
const webBrandDirectory = join(repositoryRoot, "packages/brand-assets/public/brand");
const androidResourcesDirectory = join(
  repositoryRoot,
  "apps/mobile/src-tauri/gen/android/app/src/main/res",
);

function generate(extraArguments = []) {
  const result = spawnSync(
    "pnpm",
    [
      "--dir",
      join(repositoryRoot, "apps/mobile"),
      "exec",
      "tauri",
      "icon",
      sourceIcon,
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

generate();
generate(["--png", "32,180,192,512"]);

for (const size of [32, 180, 192, 512]) {
  cpSync(
    join(generatedDirectory, `${size}x${size}.png`),
    join(webBrandDirectory, `mish-app-icon-${size}.png`),
  );
}

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

console.log("Generated shared Web, desktop, and mobile brand icons.");
