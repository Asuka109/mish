export const ELECTRON_PRODUCT_ROUTE_KEYS = [
  "status",
  "routes",
  "profiles",
  "traffic",
  "events",
  "settings",
] as const;

export type ElectronProductRouteKey = (typeof ELECTRON_PRODUCT_ROUTE_KEYS)[number];

export interface RendererProductReport {
  readonly visible: true;
  readonly routes: {
    readonly status: boolean;
    readonly routes: boolean;
    readonly profiles: boolean;
    readonly traffic: boolean;
    readonly events: boolean;
    readonly settings: boolean;
  };
  readonly statusSurface: boolean;
  readonly placeholderVisible: boolean;
}

const PLACEHOLDER_TEXT = new Set([
  "Connected",
  "Connecting",
  "Starting",
  "Session unavailable",
  "first",
  "remount",
]);

function isVisible(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      (current instanceof HTMLElement && current.hidden) ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const view = current.ownerDocument.defaultView;
    if (view) {
      const style = view.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    current = current.parentElement;
  }
  const geometry = (element as HTMLElement).getBoundingClientRect?.();
  if (!geometry) return true;
  return geometry.width > 0 && geometry.height > 0;
}

function hasVisibleRoute(root: ParentNode, path: string): boolean {
  return Array.from(root.querySelectorAll(`a[href="${path}"]`)).some(isVisible);
}

/**
 * Converts the renderer's visible product DOM into a closed, bounded signal.
 * No text, token, path, or raw DOM is sent across the host boundary.
 */
export function inspectProductSurface(root: ParentNode = document): RendererProductReport {
  const routes = {
    status: hasVisibleRoute(root, "/status"),
    routes: hasVisibleRoute(root, "/routes"),
    profiles: hasVisibleRoute(root, "/profiles"),
    traffic: hasVisibleRoute(root, "/traffic"),
    events: hasVisibleRoute(root, "/events"),
    settings: hasVisibleRoute(root, "/settings"),
  };
  const statusSurface = Array.from(root.querySelectorAll('[data-product-page="status"]')).some(
    isVisible,
  );
  const placeholderVisible = Array.from(root.querySelectorAll("*"))
    .filter(isVisible)
    .some((element) => PLACEHOLDER_TEXT.has(element.textContent?.trim() ?? ""));
  return { visible: true, routes, statusSurface, placeholderVisible };
}
