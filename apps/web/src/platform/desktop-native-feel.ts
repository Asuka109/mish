const TEXT_INTERACTION_TARGETS = [
  "code",
  "input",
  "pre",
  "textarea",
  "[contenteditable='true']",
  "[data-native-text-interaction]",
].join(",");

const WEB_DRAG_TARGETS = ["a[href]", "img"].join(",");
const NATIVE_SEARCH_TARGET = "[data-native-search]:not(:disabled)";

function closestTarget(event: Event, selector: string) {
  if (!(event.target instanceof Element)) return null;
  return event.target.closest(selector);
}

export function installDesktopNativeFeel(
  runtime: "browser" | "desktop",
  targetDocument: Document = document,
) {
  if (runtime !== "desktop") return () => undefined;

  const preventBrowserContextMenu = (event: Event) => {
    if (closestTarget(event, TEXT_INTERACTION_TARGETS)) return;
    event.preventDefault();
  };
  const preventWebContentDrag = (event: Event) => {
    if (closestTarget(event, "[data-native-draggable='true']")) return;
    if (!closestTarget(event, WEB_DRAG_TARGETS)) return;
    event.preventDefault();
  };
  const routeFindShortcut = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.shiftKey ||
      (!event.metaKey && !event.ctrlKey) ||
      event.key.toLowerCase() !== "f"
    ) {
      return;
    }

    event.preventDefault();
    const search = targetDocument.querySelector<HTMLInputElement>(NATIVE_SEARCH_TARGET);
    search?.focus({ preventScroll: true });
    search?.select();
  };

  targetDocument.addEventListener("contextmenu", preventBrowserContextMenu);
  targetDocument.addEventListener("dragstart", preventWebContentDrag);
  targetDocument.addEventListener("keydown", routeFindShortcut);

  return () => {
    targetDocument.removeEventListener("contextmenu", preventBrowserContextMenu);
    targetDocument.removeEventListener("dragstart", preventWebContentDrag);
    targetDocument.removeEventListener("keydown", routeFindShortcut);
  };
}
