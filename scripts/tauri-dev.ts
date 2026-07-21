import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const defaultWebDevelopmentPort = 4173;

function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen({ exclusive: true, host: "127.0.0.1", port }, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

export async function findAvailablePort(startPort = defaultWebDevelopmentPort): Promise<number> {
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65_535) {
    throw new Error(`Invalid development port: ${startPort}`);
  }

  for (let port = startPort; port <= 65_535; port += 1) {
    if (await portIsAvailable(port)) return port;
  }

  throw new Error(`No available development port at or above ${startPort}`);
}

export function createTauriDevelopmentConfig(origin: string, demo = false): string {
  return JSON.stringify({
    ...(demo
      ? {
          identifier: "com.asuka109.mish.demo",
          productName: "Mish Demo",
        }
      : {}),
    build: {
      ...(demo ? { beforeDevCommand: "pnpm --dir ../.. --filter @mish/web dev:demo" } : {}),
      devUrl: origin,
    },
  });
}

export function parseTauriDevelopmentArguments(arguments_: string[]): {
  demo: boolean;
  forwarded: string[];
} {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  return {
    demo: normalized.includes("--demo"),
    forwarded: normalized.filter((argument) => argument !== "--demo"),
  };
}

async function run(): Promise<void> {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const desktopRoot = path.join(repositoryRoot, "apps", "desktop");
  const port = await findAvailablePort();
  const origin = `http://127.0.0.1:${port}`;
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const invocation = parseTauriDevelopmentArguments(process.argv.slice(2));
  const environment = {
    ...process.env,
    MISH_DEV_ORIGIN: origin,
    MISH_WEB_PORT: String(port),
  };
  if (invocation.demo) environment.MISH_DESKTOP_DEMO = "1";
  else delete environment.MISH_DESKTOP_DEMO;
  const child = spawn(
    pnpm,
    [
      "exec",
      "tauri",
      "dev",
      "--config",
      createTauriDevelopmentConfig(origin, invocation.demo),
      ...invocation.forwarded,
    ],
    {
      cwd: desktopRoot,
      env: environment,
      stdio: "inherit",
    },
  );

  console.log(`Mish desktop ${invocation.demo ? "demo" : "development"} origin: ${origin}`);

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
