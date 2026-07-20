import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(repositoryRoot, ".scratch/mobile-core-contract");
const executable = path.join(outputDirectory, "contract-test");
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
