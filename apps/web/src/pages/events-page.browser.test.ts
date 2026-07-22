import { page } from "vitest/browser";
import { beforeAll, describe, expect, test, vi } from "vitest";

beforeAll(async () => {
  localStorage.setItem("mish.locale", "en");
  document.body.innerHTML = '<div id="root"></div>';
  await import("../main");

  await vi.waitFor(() => {
    expect(document.querySelector(".app-shell")).not.toBeNull();
  });
});

async function openEvents() {
  window.history.pushState({}, "", "/events");
  window.dispatchEvent(new PopStateEvent("popstate"));

  await vi.waitFor(() => {
    expect(document.querySelector(".events-controls")).not.toBeNull();
    expect(document.querySelector(".route-loading")).toBeNull();
  });
}

describe("Events toolbar", () => {
  test("uses unclipped icon controls with names, tooltips, and keyboard focus on wide desktop", async () => {
    await page.viewport(1280, 800);
    await openEvents();

    const toolbar = document.querySelector<HTMLElement>(".events-controls");
    if (!toolbar) throw new Error("Missing Events toolbar");

    const toolbarRect = toolbar.getBoundingClientRect();
    const controls = ["Pause View", "Following latest", "Clear Local"].map((label) => {
      const control = toolbar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      if (!control) throw new Error(`Missing ${label} control`);
      return control;
    });

    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      expect(control.classList.contains("ui-button--icon-sm")).toBe(true);
      expect(control.querySelector("svg")).not.toBeNull();
      expect(getComputedStyle(control.querySelector(".events-toolbar-button-label")!).display).toBe(
        "none",
      );
      expect(rect.left).toBeGreaterThanOrEqual(toolbarRect.left);
      expect(rect.right).toBeLessThanOrEqual(toolbarRect.right);
      if (control.disabled) {
        expect(control.disabled).toBe(true);
      } else {
        control.focus();
        expect(document.activeElement).toBe(control);
      }
    }

    await page.elementLocator(controls[0]!).hover();
    await vi.waitFor(() => {
      expect(document.querySelector(".tooltip-content")?.textContent).toBe("Pause View");
    });
  });
});
