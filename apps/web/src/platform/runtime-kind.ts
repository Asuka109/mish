export type RuntimeKind = "browser" | "desktop" | "mobile";

interface RuntimeKindInput {
  buildTarget?: string;
  tauri: boolean;
}

export function resolveRuntimeKind({ buildTarget, tauri }: RuntimeKindInput): RuntimeKind {
  if (buildTarget === "mobile") {
    if (!tauri) throw new Error("The mobile build requires a Tauri host");
    return "mobile";
  }
  return tauri ? "desktop" : "browser";
}
