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

function clearSearchInput(input: HTMLInputElement) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function installDesktopNativeFeel(
  runtime: "browser" | "desktop",
  targetDocument: Document = document,
) {
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
      !event.metaKey ||
      event.ctrlKey ||
      event.key.toLowerCase() !== "f"
    ) {
      return;
    }

    event.preventDefault();
    focusDesktopSearch(targetDocument);
  };
  const handleSearchEscape = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.key !== "Escape" ||
      !(targetDocument.activeElement instanceof HTMLInputElement) ||
      !targetDocument.activeElement.matches(NATIVE_SEARCH_TARGET)
    ) {
      return;
    }

    event.preventDefault();
    if (targetDocument.activeElement.value) {
      clearSearchInput(targetDocument.activeElement);
    } else {
      targetDocument.activeElement.blur();
    }
  };

  targetDocument.addEventListener("dragstart", preventWebContentDrag);
  if (runtime === "desktop") {
    targetDocument.addEventListener("contextmenu", preventBrowserContextMenu);
    targetDocument.addEventListener("keydown", routeFindShortcut);
    targetDocument.addEventListener("keydown", handleSearchEscape);
  }

  return () => {
    targetDocument.removeEventListener("dragstart", preventWebContentDrag);
    if (runtime === "desktop") {
      targetDocument.removeEventListener("contextmenu", preventBrowserContextMenu);
      targetDocument.removeEventListener("keydown", routeFindShortcut);
      targetDocument.removeEventListener("keydown", handleSearchEscape);
    }
  };
}

export function focusDesktopSearch(targetDocument: Document = document) {
  const search = targetDocument.querySelector<HTMLInputElement>(NATIVE_SEARCH_TARGET);
  if (!search) return false;
  search.focus({ preventScroll: true });
  search.select();
  return true;
}
