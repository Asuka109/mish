import { invoke, isTauri } from "@tauri-apps/api/core";

export type SystemProxySettingsOpenOutcome = "dispatch-failed" | "opened" | "unsupported-version";

export interface SystemProxySettingsOpener {
  open(): Promise<SystemProxySettingsOpenOutcome>;
}

interface SystemProxySettingsDependencies {
  invoke(command: string): Promise<unknown>;
  isTauri(): boolean;
}

const outcomes = new Set<SystemProxySettingsOpenOutcome>([
  "dispatch-failed",
  "opened",
  "unsupported-version",
]);

export async function openSystemProxySettings(
  dependencies: SystemProxySettingsDependencies,
): Promise<SystemProxySettingsOpenOutcome> {
  if (!dependencies.isTauri()) return "unsupported-version";
  const outcome = await dependencies.invoke("open_system_proxy_settings");
  return typeof outcome === "string" && outcomes.has(outcome as SystemProxySettingsOpenOutcome)
    ? (outcome as SystemProxySettingsOpenOutcome)
    : "dispatch-failed";
}

export const nativeSystemProxySettingsOpener: SystemProxySettingsOpener = {
  open: () => openSystemProxySettings({ invoke, isTauri }),
};
