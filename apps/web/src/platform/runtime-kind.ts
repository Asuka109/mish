export type RuntimeKind = "browser" | "desktop" | "mobile";

interface RuntimeKindInput {
  buildTarget?: string;
  electron?: boolean;
  tauri: boolean;
}

export function resolveRuntimeKind({
  buildTarget,
  electron = false,
  tauri,
}: RuntimeKindInput): RuntimeKind {
  if (buildTarget === "mobile") {
    if (!tauri) throw new Error("The mobile build requires a Tauri host");
    return "mobile";
  }
  if (electron) return "desktop";
  return tauri ? "desktop" : "browser";
}
