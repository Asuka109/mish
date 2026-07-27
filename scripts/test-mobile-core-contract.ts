import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(repositoryRoot, ".scratch/mobile-core-contract");
const executable = path.join(outputDirectory, "contract-test");
const androidBridgeExecutable = path.join(outputDirectory, "android-validation-bridge-test");
mkdirSync(outputDirectory, { recursive: true });

execFileSync(
  process.env.CC ?? "clang",
  [
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pedantic",
    path.join(repositoryRoot, "mobile-core/fixture/mish_mobile_core_fixture.c"),
    path.join(repositoryRoot, "mobile-core/tests/contract_test.c"),
    "-o",
    executable,
  ],
  { stdio: "inherit" },
);
execFileSync(executable, { stdio: "inherit" });

execFileSync(
  process.env.CC ?? "clang",
  [
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pedantic",
    `-I${path.join(repositoryRoot, "mobile-core/abi")}`,
    path.join(
      repositoryRoot,
      "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/cpp/mish_vpn_core_validation.c",
    ),
    path.join(repositoryRoot, "mobile-core/tests/android_validation_bridge_test.c"),
    "-o",
    androidBridgeExecutable,
  ],
  { stdio: "inherit" },
);
execFileSync(androidBridgeExecutable, { stdio: "inherit" });
