export type ElectronHostMode = "default" | "fixture-auto-quit";

export type ElectronHostSignal =
  | "renderer-ready"
  | "renderer-failure"
  | "renderer-timeout"
  | "user-close";

export type ElectronQuitDecision = "keep-open" | "request-quit";

export function quitDecision(
  mode: ElectronHostMode,
  signal: ElectronHostSignal,
): ElectronQuitDecision {
  if (signal === "user-close" || mode === "fixture-auto-quit") return "request-quit";
  return "keep-open";
}
