import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useNavigate } from "react-router";

const nativeDestinations = new Set([
  "/events",
  "/profiles",
  "/routes",
  "/settings",
  "/status",
  "/traffic",
]);

interface NativeNavigationDependencies {
  isDesktop(): boolean;
  listen(handler: (destination: string) => void): Promise<UnlistenFn>;
}

const defaultDependencies: NativeNavigationDependencies = {
  isDesktop: isTauri,
  listen: (handler) =>
    listen<string>("mish:navigate", (event) => {
      handler(event.payload);
    }),
};

export function isNativeDestination(destination: string) {
  return nativeDestinations.has(destination);
}

export function NativeNavigationBridge({
  dependencies = defaultDependencies,
}: {
  dependencies?: NativeNavigationDependencies;
}) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!dependencies.isDesktop()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void dependencies
      .listen((destination) => {
        if (!disposed && isNativeDestination(destination)) navigate(destination);
      })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dependencies, navigate]);

  return null;
}
