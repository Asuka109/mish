import { describe, expect, it } from "vitest";
import { installDesktopNativeFeel } from "./desktop-native-feel";

function dispatchCancelable(target: Element, type: "contextmenu" | "dragstart") {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("desktop native-feel behavior", () => {
  it("suppresses browser context menus outside editable text", () => {
    const copy = document.createElement("span");
    const input = document.createElement("input");
    const code = document.createElement("code");
    document.body.append(copy, input, code);
    const dispose = installDesktopNativeFeel("desktop");

    expect(dispatchCancelable(copy, "contextmenu").defaultPrevented).toBe(true);
    expect(dispatchCancelable(input, "contextmenu").defaultPrevented).toBe(false);
    expect(dispatchCancelable(code, "contextmenu").defaultPrevented).toBe(false);

    dispose();
    copy.remove();
    input.remove();
    code.remove();
  });

  it("blocks browser dragging for images and links unless explicitly opted in", () => {
    const image = document.createElement("img");
    const link = document.createElement("a");
    const draggableImage = document.createElement("img");
    link.href = "/status";
    draggableImage.dataset.nativeDraggable = "true";
    document.body.append(image, link, draggableImage);
    const dispose = installDesktopNativeFeel("desktop");

    expect(dispatchCancelable(image, "dragstart").defaultPrevented).toBe(true);
    expect(dispatchCancelable(link, "dragstart").defaultPrevented).toBe(true);
    expect(dispatchCancelable(draggableImage, "dragstart").defaultPrevented).toBe(false);

    dispose();
    image.remove();
    link.remove();
    draggableImage.remove();
  });

  it("does not change browser behavior and removes desktop listeners on cleanup", () => {
    const image = document.createElement("img");
    document.body.append(image);

    installDesktopNativeFeel("browser");
    expect(dispatchCancelable(image, "dragstart").defaultPrevented).toBe(false);

    const dispose = installDesktopNativeFeel("desktop");
    dispose();
    expect(dispatchCancelable(image, "dragstart").defaultPrevented).toBe(false);

    image.remove();
  });

  it("routes the desktop find shortcut to the current page search field", () => {
    const search = document.createElement("input");
    search.dataset.nativeSearch = "true";
    search.value = "example";
    document.body.append(search);
    const dispose = installDesktopNativeFeel("desktop");
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "f",
      metaKey: true,
    });

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(search.value.length);

    dispose();
    search.remove();
  });
});
