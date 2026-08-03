import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectDevelopmentMihomo, type DevelopmentMihomoSelection } from "./development-mihomo.ts";

export const defaultWebDevelopmentPort = 4173;
export const tartTunAcceptanceArgument = "--tart-tun-acceptance";
export const openBrowserArgument = "--open";

export interface TauriDevelopmentInvocation {
  application: string[];
  demo: boolean;
  forwarded: string[];
  openBrowser: boolean;
  tartTunAcceptance: boolean;
}

export interface HostUrlOpenerCommand {
  arguments: string[];
  command: string;
}

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

export function parseTauriDevelopmentArguments(arguments_: string[]): TauriDevelopmentInvocation {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const isDevtoolsArgument = (argument: string): boolean =>
    argument === "--devtools" || argument.startsWith("--devtools=");
  return {
    application: normalized.filter(isDevtoolsArgument),
    demo: normalized.includes("--demo"),
    forwarded: normalized.filter(
      (argument) =>
        argument !== "--demo" &&
        argument !== openBrowserArgument &&
        argument !== tartTunAcceptanceArgument &&
        !isDevtoolsArgument(argument),
    ),
    openBrowser: normalized.includes(openBrowserArgument),
    tartTunAcceptance: normalized.includes(tartTunAcceptanceArgument),
  };
}

export function hostUrlOpenerCommand(platform: NodeJS.Platform, url: string): HostUrlOpenerCommand {
  if (platform === "darwin") return { arguments: [url], command: "open" };
  if (platform === "win32") {
    return {
      arguments: ["/d", "/s", "/c", "start", "", url],
      command: "cmd.exe",
    };
  }
  return { arguments: [url], command: "xdg-open" };
}

export function browserClientUrlFromOutput(output: string): string | null {
  const match = output.match(
    /(?:^|\n)Mish Browser Client URL: (http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43})(?:\r?\n|$)/u,
  );
  return match?.[1] ?? null;
}

export function openBrowserClient(url: string, platform = process.platform): void {
  const opener = hostUrlOpenerCommand(platform, url);
  try {
    const child = spawn(opener.command, opener.arguments, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => {
      console.error("Mish Browser Client opener failed; the desktop backend remains available.");
    });
    child.once("exit", (code) => {
      if (code === 0) return;
      console.error("Mish Browser Client opener failed; the desktop backend remains available.");
    });
    child.unref();
  } catch {
    console.error("Mish Browser Client opener failed; the desktop backend remains available.");
  }
}

export function createTauriDevelopmentEnvironment(
  base: NodeJS.ProcessEnv,
  origin: string,
  invocation: TauriDevelopmentInvocation,
  selectedMihomo: DevelopmentMihomoSelection | null,
): NodeJS.ProcessEnv {
  const environment = {
    ...base,
    MISH_DEV_ORIGIN: origin,
    MISH_WEB_PORT: new URL(origin).port,
  };
  if (invocation.demo) environment.MISH_DESKTOP_DEMO = "1";
  else delete environment.MISH_DESKTOP_DEMO;
  if (selectedMihomo) {
    environment.MISH_DEVELOPMENT_CORE_SOURCE = selectedMihomo.source;
    environment.MISH_MIHOMO_BIN = selectedMihomo.binary;
  } else {
    delete environment.MISH_DEVELOPMENT_CORE_SOURCE;
    delete environment.MISH_MIHOMO_BIN;
  }
  if (!invocation.demo && invocation.tartTunAcceptance) {
    environment.MISH_TART_TUN_ACCEPTANCE = "1";
  } else {
    delete environment.MISH_TART_TUN_ACCEPTANCE;
  }
  return environment;
}

export function isTauriDevelopmentStartupAbort(output: string): boolean {
  return (
    output.includes("Failed to setup app:") ||
    output.includes("thread caused non-unwinding panic. aborting.")
  );
}

export function resolveTauriDevelopmentExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
  startupAborted: boolean,
): number {
  if (startupAborted || signal) return 1;
  return code ?? 1;
}

async function run(): Promise<void> {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const desktopRoot = path.join(repositoryRoot, "apps", "desktop");
  const port = await findAvailablePort();
  const origin = `http://127.0.0.1:${port}`;
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const invocation = parseTauriDevelopmentArguments(process.argv.slice(2));
  const selectedMihomo = invocation.demo
    ? null
    : await selectDevelopmentMihomo(repositoryRoot, process.env.MISH_MIHOMO_BIN);
  const environment = createTauriDevelopmentEnvironment(
    process.env,
    origin,
    invocation,
    selectedMihomo,
  );
  const child = spawn(
    pnpm,
    [
      "exec",
      "tauri",
      "dev",
      ...(invocation.demo
        ? []
        : ["--features", "development-core-host,development-window-trigger"]),
      "--config",
      createTauriDevelopmentConfig(origin, invocation.demo),
      ...invocation.forwarded,
      ...(invocation.application.length > 0 ? ["--", "--", ...invocation.application] : []),
    ],
    {
      cwd: desktopRoot,
      env: environment,
      stdio: ["inherit", "pipe", "pipe"],
    },
  );

  console.log(`Mish desktop ${invocation.demo ? "demo" : "development"} origin: ${origin}`);

  let startupOutput = "";
  let startupAborted = false;
  let browserOutput = "";
  let browserOpened = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    const output = chunk.toString();
    process.stdout.write(output);
    if (!invocation.openBrowser || browserOpened) return;

    browserOutput = `${browserOutput}${output}`.slice(-1024);
    const url = browserClientUrlFromOutput(browserOutput);
    if (!url) return;

    browserOpened = true;
    openBrowserClient(url);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const output = chunk.toString();
    process.stderr.write(output);
    startupOutput = `${startupOutput}${output}`.slice(-1024);
    startupAborted ||= isTauriDevelopmentStartupAbort(startupOutput);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(resolveTauriDevelopmentExitCode(code, signal, startupAborted));
    });
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
