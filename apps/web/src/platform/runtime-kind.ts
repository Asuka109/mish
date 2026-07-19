export type RuntimeKind = "browser" | "desktop" | "mobile";

interface RuntimeKindInput {
  buildMode: string;
  tauri: boolean;
}

export function resolveRuntimeKind({ buildMode, tauri }: RuntimeKindInput): RuntimeKind {
  if (buildMode === "mobile") {
    if (!tauri) throw new Error("The mobile build requires a Tauri host");
    return "mobile";
  }
  return tauri ? "desktop" : "browser";
}
