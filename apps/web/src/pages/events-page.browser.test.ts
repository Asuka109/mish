import { page } from "vitest/browser";
import { beforeAll, describe, expect, test, vi } from "vitest";

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await import("../main");

  await vi.waitFor(
    () => {
      expect(document.querySelector(".app-shell")).not.toBeNull();
    },
    { timeout: 10_000 },
  );
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
  test.each([
    [1280, 800],
    [800, 600],
  ])("keeps only the intended body scrolling at %ix%i", async (width, height) => {
    await page.viewport(width, height);
    await vi.waitFor(() => {
      expect(window.innerWidth).toBe(width);
      expect(window.innerHeight).toBe(height);
    });
    await openEvents();

    const scrollers = document.querySelectorAll<HTMLElement>("main .workspace-page-scroll");
    const scroller = scrollers[0];
    const body = document.querySelector<HTMLElement>(".events-body");
    const heading = document.querySelector<HTMLElement>(".events-heading");
    const pageElement = document.querySelector<HTMLElement>(".events-page");
    if (!scroller || !body || !heading || !pageElement)
      throw new Error("Missing Events scroll geometry");

    scroller.scrollTop = 0;
    const before = {
      bodyHeight: body.clientHeight,
      bodyTop: body.getBoundingClientRect().top,
      clientHeight: scroller.clientHeight,
      headingTop: heading.getBoundingClientRect().top,
      scrollerBottom: scroller.getBoundingClientRect().bottom,
      scrollerTop: scroller.getBoundingClientRect().top,
    };

    window.history.pushState({}, "", "/events?diagnostics=1");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await vi.waitFor(() => {
      expect(document.querySelector(".events-controls")).not.toBeNull();
    });
    expect(document.querySelector(".diagnostics-section")).toBeNull();
    expect(document.querySelector('a[href="/events?diagnostics=1"]')).toBeNull();
    expect(scrollers).toHaveLength(1);
    expect(scroller.scrollTop).toBe(0);
    expect(scroller.scrollHeight).toBe(scroller.clientHeight);
    expect(getComputedStyle(body).overflowY).toBe("auto");
    expect(body.clientHeight).toBe(before.bodyHeight);
    expect(body.getBoundingClientRect().top).toBe(before.bodyTop);
    expect(scroller.clientHeight).toBe(before.clientHeight);
    expect(scroller.getBoundingClientRect().top).toBe(before.scrollerTop);
    expect(scroller.getBoundingClientRect().bottom).toBe(before.scrollerBottom);
    expect(heading.getBoundingClientRect().top).toBe(before.headingTop);
    expect(before.scrollerBottom).toBeCloseTo(height - 11, 0);

    const notificationTrigger = document.querySelector<HTMLButtonElement>(".notification-trigger");
    if (!notificationTrigger) throw new Error("Missing notification trigger");
    notificationTrigger.click();
    await vi.waitFor(() => expect(document.querySelector(".notification-popover")).not.toBeNull());
    expect(body.clientHeight).toBe(before.bodyHeight);
    expect(body.getBoundingClientRect().top).toBe(before.bodyTop);
    expect(heading.getBoundingClientRect().top).toBe(before.headingTop);
    notificationTrigger.click();
    await vi.waitFor(() => expect(document.querySelector(".notification-popover")).toBeNull());
    expect(body.clientHeight).toBe(before.bodyHeight);
    expect(heading.getBoundingClientRect().top).toBe(before.headingTop);
  });

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
