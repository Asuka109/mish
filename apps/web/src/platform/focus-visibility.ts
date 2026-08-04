const KEYBOARD_FOCUS_ATTRIBUTE = "data-mish-focus-visible";
const KEYBOARD_FOCUS_MOVE_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);
const ACTIONABLE_SELECTOR = [
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "a[href]",
  "area[href]",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='radio']",
  "[role='searchbox']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
  "[role='treeitem']",
].join(",");

function isActionableFocusTarget(target: Element, targetDocument: Document) {
  const targetWindow = targetDocument.defaultView;
  if (!targetWindow || !(target instanceof targetWindow.HTMLElement)) return false;
  if (!target.isConnected) return false;
  if (target.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  if (target.matches(":disabled, [aria-disabled='true']")) return false;
  if (target.tabIndex < 0 && !target.matches(ACTIONABLE_SELECTOR)) return false;

  const style = targetWindow.getComputedStyle(target);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse"
  ) {
    return false;
  }
  return target.getClientRects().length > 0;
}

function isKeyboardFocusMove(event: KeyboardEvent) {
  if (KEYBOARD_FOCUS_MOVE_KEYS.has(event.key)) return true;
  return event.key.length === 1 && Boolean(event.key.trim());
}

export function installFocusVisibility(targetDocument: Document = document) {
  const targetWindow = targetDocument.defaultView;
  if (!targetWindow) return () => undefined;
  let indicatedTarget: HTMLElement | null = null;
  let pendingFocusSequence = 0;
  let pendingFocusKind: "tab" | "keyboard-move" | null = null;
  let pendingTimer: number | null = null;

  const clearIndicatedTarget = () => {
    indicatedTarget?.removeAttribute(KEYBOARD_FOCUS_ATTRIBUTE);
    indicatedTarget = null;
  };
  const markTarget = (target: Element) => {
    if (!isActionableFocusTarget(target, targetDocument)) return false;
    clearIndicatedTarget();
    target.setAttribute(KEYBOARD_FOCUS_ATTRIBUTE, "keyboard");
    indicatedTarget = target as HTMLElement;
    return true;
  };
  const cancelPendingFocus = () => {
    pendingFocusSequence += 1;
    if (pendingTimer !== null) targetWindow.clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingFocusKind = null;
  };
  const clearPointerFocus = () => {
    cancelPendingFocus();
    clearIndicatedTarget();
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const kind =
      event.key === "Tab"
        ? "tab"
        : indicatedTarget === targetDocument.activeElement && isKeyboardFocusMove(event)
          ? "keyboard-move"
          : null;
    if (!kind) return;

    cancelPendingFocus();
    const sequence = pendingFocusSequence;
    pendingFocusKind = kind;
    pendingTimer = targetWindow.setTimeout(() => {
      pendingTimer = null;
      const focusKind = pendingFocusKind;
      pendingFocusKind = null;
      if (sequence !== pendingFocusSequence || focusKind !== "tab") return;
      const target = targetDocument.activeElement;
      if (target && markTarget(target)) pendingFocusSequence += 1;
    });
  };
  const handleFocusIn = (event: FocusEvent) => {
    clearIndicatedTarget();
    if (pendingFocusKind === null || !(event.target instanceof targetWindow.Element)) return;
    if (!markTarget(event.target)) return;
    cancelPendingFocus();
  };
  const handleFocusOut = (event: FocusEvent) => {
    if (event.target !== indicatedTarget) return;
    clearIndicatedTarget();
  };
  const validateIndicatedTarget = () => {
    if (!indicatedTarget || isActionableFocusTarget(indicatedTarget, targetDocument)) return;
    clearIndicatedTarget();
  };
  const observer = new targetWindow.MutationObserver(validateIndicatedTarget);

  targetDocument.addEventListener("keydown", handleKeyDown, true);
  targetDocument.addEventListener("focusin", handleFocusIn, true);
  targetDocument.addEventListener("focusout", handleFocusOut, true);
  targetDocument.addEventListener("pointerdown", clearPointerFocus, true);
  targetDocument.addEventListener("mousedown", clearPointerFocus, true);
  targetDocument.addEventListener("touchstart", clearPointerFocus, true);
  observer.observe(targetDocument.documentElement, {
    attributeFilter: [
      "aria-disabled",
      "aria-hidden",
      "class",
      "disabled",
      "hidden",
      "inert",
      "style",
    ],
    attributes: true,
    childList: true,
    subtree: true,
  });

  return () => {
    cancelPendingFocus();
    clearIndicatedTarget();
    observer.disconnect();
    targetDocument.removeEventListener("keydown", handleKeyDown, true);
    targetDocument.removeEventListener("focusin", handleFocusIn, true);
    targetDocument.removeEventListener("focusout", handleFocusOut, true);
    targetDocument.removeEventListener("pointerdown", clearPointerFocus, true);
    targetDocument.removeEventListener("mousedown", clearPointerFocus, true);
    targetDocument.removeEventListener("touchstart", clearPointerFocus, true);
  };
}
