import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

export interface SimulatedHostHarnessDescriptor {
  authToken: string;
  controlKey: string;
  controlUrl: string;
  rpcUrl: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    simulatedHostHarness: SimulatedHostHarnessDescriptor;
  }
}

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));

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

export default async function setup(project: TestProject) {
  const child = spawn(
    "cargo",
    [
      "run",
      "--quiet",
      "-p",
      "mish-simulated-host",
      "--features",
      "scenario-harness",
      "--bin",
      "mish-simulated-host",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, RUST_BACKTRACE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const descriptor = await readDescriptor(child);
  project.provide("simulatedHostHarness", descriptor);
  return () => stopHarness(child);
}
