import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

export const simulatedHostScenarioNames = [
  "cancelled",
  "commit-drift",
  "confirmed-rollback",
  "early-conflict",
  "helper-install",
  "helper-repair",
  "recovery-required",
  "replacement",
] as const;

export type SimulatedHostScenarioName = (typeof simulatedHostScenarioNames)[number];

export interface SimulatedHostHarnessDescriptor {
  authToken: string;
  controlKey: string;
  controlUrl: string;
  rpcUrl: string;
  scenario: SimulatedHostScenarioName;
}

declare module "vitest" {
  export interface ProvidedContext {
    simulatedHostHarnesses: Record<SimulatedHostScenarioName, SimulatedHostHarnessDescriptor>;
  }
}

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const harnessBinary = resolve(
  repositoryRoot,
  "target",
  "debug",
  process.platform === "win32" ? "mish-simulated-host.exe" : "mish-simulated-host",
);

function buildHarness() {
  return new Promise<void>((resolveBuild, reject) => {
    const child = spawn(
      "cargo",
      [
        "build",
        "--quiet",
        "-p",
        "mish-simulated-host",
        "--features",
        "scenario-harness",
        "--bin",
        "mish-simulated-host",
      ],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const record = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-8_192);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveBuild();
      else reject(new Error(`Simulated host build failed (${String(code)}): ${output}`));
    });
  });
}

function readDescriptor(child: ChildProcessWithoutNullStreams) {
  return new Promise<SimulatedHostHarnessDescriptor>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(stdout.slice(0, newline)) as SimulatedHostHarnessDescriptor);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Simulated host harness exited before startup (code ${String(code)}): ${stderr.slice(-4_096)}`,
        ),
      );
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onStderr = (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_192);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopHarness(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function spawnHarness(scenario: SimulatedHostScenarioName) {
  return spawn(harnessBinary, [], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      MISH_SIMULATED_SCENARIO: scenario,
      RUST_BACKTRACE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export default async function setup(project: TestProject) {
  await buildHarness();
  const children: ChildProcessWithoutNullStreams[] = [];
  const descriptors = {} as Record<SimulatedHostScenarioName, SimulatedHostHarnessDescriptor>;
  try {
    for (const scenario of simulatedHostScenarioNames) {
      const child = spawnHarness(scenario);
      children.push(child);
      const descriptor = await readDescriptor(child);
      if (descriptor.scenario !== scenario) {
        throw new Error(`Expected ${scenario} harness, received ${descriptor.scenario}`);
      }
      descriptors[scenario] = descriptor;
    }
  } catch (error) {
    await Promise.all(children.map(stopHarness));
    throw error;
  }
  project.provide("simulatedHostHarnesses", descriptors);
  return () => Promise.all(children.map(stopHarness));
}
