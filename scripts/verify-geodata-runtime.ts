import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempDisposableSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const snapshot = path.join(repositoryRoot, "resources/geodata/snapshot");
const binary = path.resolve(
  process.env.MISH_MIHOMO_BIN ??
    path.join(repositoryRoot, ".scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29"),
);
const expectedRuntimeNames = ["GeoSite.dat", "GeoIP.dat", "geoip.metadb", "ASN.mmdb"];

if (!existsSync(binary)) {
  throw new Error("The pinned Mihomo binary is missing; run `pnpm prepare:mihomo` first");
}

const manifest = JSON.parse(readFileSync(path.join(snapshot, "manifest.json"), "utf8")) as {
  assets: Array<{
    bytes: number;
    name: string;
    runtimeName: string;
    sha256: string;
  }>;
  schemaVersion: number;
};
if (
  manifest.schemaVersion !== 2 ||
  JSON.stringify(manifest.assets.map(({ runtimeName }) => runtimeName)) !==
    JSON.stringify(expectedRuntimeNames)
) {
  throw new Error("The GeoData manifest does not declare the exact Mihomo runtime names");
}

using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-geodata-runtime-"));
for (const asset of manifest.assets) {
  const source = path.join(snapshot, asset.name);
  const contents = readFileSync(source);
  if (
    contents.byteLength !== asset.bytes ||
    createHash("sha256").update(contents).digest("hex") !== asset.sha256
  ) {
    throw new Error(`The GeoData snapshot is invalid: ${asset.name}`);
  }
  copyFileSync(source, path.join(temporary.path, asset.runtimeName));
}

const base = `
mixed-port: 17990
external-controller: 127.0.0.1:19091
mode: rule
log-level: info
geodata-loader: memconservative
geox-url:
  geoip: http://127.0.0.1:9/geoip.dat
  geosite: http://127.0.0.1:9/geosite.dat
  mmdb: http://127.0.0.1:9/geoip.metadb
  asn: http://127.0.0.1:9/GeoLite2-ASN.mmdb
rules:
  - GEOSITE,cn,DIRECT
  - GEOIP,CN,DIRECT
  - IP-ASN,13335,DIRECT
  - MATCH,DIRECT
`;

for (const geodataMode of [false, true]) {
  const config = path.join(temporary.path, `config-${geodataMode ? "dat" : "metadb"}.yaml`);
  writeFileSync(config, `${base}geodata-mode: ${String(geodataMode)}\n`);
  const result = spawnSync(binary, ["-t", "-d", temporary.path, "-f", config], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    result.status !== 0 ||
    /start download|can't download/iu.test(output) ||
    !output.includes("test is successful")
  ) {
    throw new Error(
      `Pinned Mihomo did not accept the offline ${geodataMode ? "dat" : "metadb"} GeoData seed`,
    );
  }
}

console.log("Verified pinned Mihomo offline GeoData fallback in dat and MetaDB modes");
