import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.env.PNPM ?? "pnpm",
  ["exec", "vitest", "run", "test/replay-output.test.ts", "--reporter=dot"],
  {
    cwd: packageRoot,
    env: { ...process.env, MISH_RN_REPLAY_OUTPUT: "1" },
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
