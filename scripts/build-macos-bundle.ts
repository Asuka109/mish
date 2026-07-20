import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("macOS bundles must be built on Apple Silicon macOS");
}

const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "-";
const mihomo = path.resolve(".scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29");
const expectedMihomoSha256 = "ec66e3e883bdc3fca06753784e324e08921e13239f8e945587cb1bfbf4c6b936";

execFileSync("pnpm", ["prepare:mihomo"], { stdio: "inherit" });
const mihomoSha256 = createHash("sha256").update(readFileSync(mihomo)).digest("hex");
if (mihomoSha256 !== expectedMihomoSha256) {
  throw new Error(
    `Prepared Mihomo checksum mismatch: expected ${expectedMihomoSha256}, received ${mihomoSha256}`,
  );
}

const signingArguments = ["--force", "--options", "runtime"];
if (identity === "-") {
  signingArguments.push("--timestamp=none");
} else {
  signingArguments.push("--timestamp");
}
signingArguments.push("--sign", identity, mihomo);
execFileSync("codesign", signingArguments, { stdio: "inherit" });

execFileSync("pnpm", ["--filter", "@mish/desktop", "bundle:macos"], {
  env: { ...process.env, APPLE_SIGNING_IDENTITY: identity },
  stdio: "inherit",
});
execFileSync("pnpm", ["desktop:bundle:verify:macos"], { stdio: "inherit" });
