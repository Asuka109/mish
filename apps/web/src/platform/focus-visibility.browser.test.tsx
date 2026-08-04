import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@mish/ui";
import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { focusCurrentRoute } from "./route-focus";
import { installFocusVisibility } from "./focus-visibility";
import "../styles.css";

let container: HTMLDivElement;
let disposeFocusVisibility: () => void;
let root: Root | null;

function expectKeyboardRing(target: HTMLElement) {
  expect(target).toHaveAttribute("data-mish-focus-visible", "keyboard");
  expect(getComputedStyle(target).outlineStyle).toBe("solid");
  expect(getComputedStyle(target).outlineWidth).toBe("2px");
}

function expectSilentFocus(target: HTMLElement) {
  expect(target).not.toHaveAttribute("data-mish-focus-visible");
  expect(getComputedStyle(target).outlineStyle).toBe("none");
}

beforeEach(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  container = document.createElement("div");
  document.body.append(container);
  root = null;
  disposeFocusVisibility = installFocusVisibility();
});

afterEach(() => {
  disposeFocusVisibility();
  root?.unmount();
  container.remove();
  delete document.documentElement.dataset.runtime;
  delete document.documentElement.dataset.theme;
  document.documentElement.lang = "";
});

for (const runtime of ["browser", "desktop", "mobile"] as const) {
  for (const theme of ["light", "dark"] as const) {
    for (const locale of ["en", "zh-CN"] as const) {
      test(`${runtime}, ${theme}, and ${locale} expose the ring only after Tab and Shift+Tab`, async () => {
        document.documentElement.dataset.runtime = runtime;
        document.documentElement.dataset.theme = theme;
        document.documentElement.lang = locale;
        const first = document.createElement("button");
        const second = document.createElement("button");
        first.textContent = locale === "zh-CN" ? "上一个操作" : "Previous Action";
        second.textContent = locale === "zh-CN" ? "下一个操作" : "Next Action";
        container.append(first, second);
        const firstRect = first.getBoundingClientRect().toJSON();

        first.focus({ preventScroll: true });
        expectSilentFocus(first);
        await userEvent.keyboard("{Tab}");
        expect(document.activeElement).toBe(second);
        expectKeyboardRing(second);

        await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
        expect(document.activeElement).toBe(first);
        expectKeyboardRing(first);
        expect(first.getBoundingClientRect().toJSON()).toEqual(firstRect);
        first.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
        );
        expectSilentFocus(first);

        await userEvent.click(page.getByRole("button", { name: second.textContent! }));
        expect(document.activeElement).toBe(second);
        expectSilentFocus(second);
      });
    }
  }
}

test("Tab covers native controls, menu items, options, and interactive rows", async () => {
  const button = document.createElement("button");
  const link = document.createElement("a");
  const input = document.createElement("input");
  const select = document.createElement("select");
  const selectOption = document.createElement("option");
  const menuItem = document.createElement("div");
  const option = document.createElement("div");
  const interactiveRow = document.createElement("div");
  button.textContent = "Button";
  link.href = "#focus-link";
  link.textContent = "Link";
  input.setAttribute("aria-label", "Form control");
  select.setAttribute("aria-label", "Select control");
  selectOption.textContent = "Selected option";
  select.append(selectOption);
  menuItem.role = "menuitem";
  menuItem.tabIndex = 0;
  menuItem.textContent = "Menu item";
  option.role = "option";
  option.tabIndex = 0;
  option.textContent = "Option";
  interactiveRow.role = "row";
  interactiveRow.tabIndex = 0;
  interactiveRow.textContent = "Interactive row";
  const targets = [button, link, input, select, menuItem, option, interactiveRow];
  container.append(...targets);

  for (const target of targets) {
    const rect = target.getBoundingClientRect().toJSON();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(target);
    expectKeyboardRing(target);
    expect(target.getBoundingClientRect().toJSON()).toEqual(rect);
  }
});

test("keyboard roving focus keeps the ring after Tab enters a control group", async () => {
  const first = document.createElement("button");
  const second = document.createElement("button");
  const third = document.createElement("button");
  first.textContent = "First destination";
  second.textContent = "Second destination";
  third.textContent = "Third destination";
  container.append(first, second, third);
  container.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") second.focus({ preventScroll: true });
    else if (event.key === "End") third.focus({ preventScroll: true });
    else if (event.key === "f") first.focus({ preventScroll: true });
  });

  await userEvent.keyboard("{Tab}");
  expectKeyboardRing(first);
  await userEvent.keyboard("{ArrowDown}");
  expectKeyboardRing(second);
  await userEvent.keyboard("{End}");
  expectKeyboardRing(third);
  await userEvent.keyboard("f");
  expectKeyboardRing(first);
});

test("route, lazy, reconnect, Profile, and notification focus transfers stay silent", async () => {
  const scroller = document.createElement("main");
  const routeHeading = document.createElement("h1");
  const lazyHeading = document.createElement("h2");
  const reconnectHeading = document.createElement("h2");
  const profileAction = document.createElement("button");
  const notificationAction = document.createElement("button");
  const tabDestination = document.createElement("button");
  scroller.className = "workspace-page-scroll";
  scroller.style.cssText = "height:80px;overflow:auto";
  routeHeading.id = "route-focus-heading";
  routeHeading.textContent = "Status";
  routeHeading.style.marginTop = "240px";
  lazyHeading.tabIndex = -1;
  reconnectHeading.tabIndex = -1;
  profileAction.textContent = "Profile changed";
  notificationAction.textContent = "Notification action finished";
  tabDestination.textContent = "Next keyboard action";
  scroller.append(
    routeHeading,
    lazyHeading,
    reconnectHeading,
    profileAction,
    notificationAction,
    tabDestination,
  );
  container.append(scroller);
  scroller.scrollTop = 37;

  profileAction.focus({ preventScroll: true });
  await userEvent.keyboard("{Tab}");
  expectKeyboardRing(notificationAction);
  const scrollBeforeRouteFocus = scroller.scrollTop;
  const routeRect = routeHeading.getBoundingClientRect().toJSON();

  expect(focusCurrentRoute(document, "#route-focus-heading")).toBe(true);
  expect(document.activeElement).toBe(routeHeading);
  expectSilentFocus(routeHeading);
  expect(scroller.scrollTop).toBe(scrollBeforeRouteFocus);
  expect(routeHeading.getBoundingClientRect().toJSON()).toEqual(routeRect);

  lazyHeading.focus({ preventScroll: true });
  expectSilentFocus(lazyHeading);
  reconnectHeading.focus({ preventScroll: true });
  expectSilentFocus(reconnectHeading);
  profileAction.focus({ preventScroll: true });
  expectSilentFocus(profileAction);
  notificationAction.focus({ preventScroll: true });
  expectSilentFocus(notificationAction);

  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(tabDestination);
  expectKeyboardRing(tabDestination);
});

test("Base UI initial focus and return stay silent until Tab moves within the trap", async () => {
  const initialFocus = createRef<HTMLButtonElement>();
  root = createRoot(container);
  root.render(
    <Dialog>
      <DialogTrigger>Open focus trap</DialogTrigger>
      <DialogContent aria-describedby={undefined} initialFocus={initialFocus}>
        <DialogTitle>Focus trap</DialogTitle>
        <button ref={initialFocus} type="button">
          Primary action
        </button>
        <button type="button">Secondary action</button>
      </DialogContent>
    </Dialog>,
  );

  const trigger = page.getByRole("button", { name: "Open focus trap" });
  await vi.waitFor(() => expect(trigger.element()).toBeInstanceOf(HTMLElement));
  await userEvent.keyboard("{Tab}");
  expectKeyboardRing(trigger.element() as HTMLElement);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(document.activeElement).toBe(initialFocus.current));
  expectSilentFocus(initialFocus.current!);

  await userEvent.keyboard("{Tab}");
  const secondary = page.getByRole("button", { name: "Secondary action" }).element();
  expect(document.activeElement).toBe(secondary);
  expectKeyboardRing(secondary as HTMLElement);

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger.element()));
  expectSilentFocus(trigger.element() as HTMLElement);
});

describe("target eligibility", () => {
  test("skips hidden, disabled, and inert controls and removes a stale indicator", async () => {
    const hidden = document.createElement("button");
    const disabled = document.createElement("button");
    const inertContainer = document.createElement("div");
    const inertAction = document.createElement("button");
    const visible = document.createElement("button");
    const transitionTarget = document.createElement("button");
    hidden.hidden = true;
    hidden.textContent = "Hidden";
    disabled.disabled = true;
    disabled.textContent = "Disabled";
    inertContainer.inert = true;
    inertAction.textContent = "Inert";
    inertContainer.append(inertAction);
    visible.textContent = "Visible";
    transitionTarget.textContent = "Transition target";
    container.append(hidden, disabled, inertContainer, visible, transitionTarget);

    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(visible);
    expectKeyboardRing(visible);

    visible.style.visibility = "hidden";
    await vi.waitFor(() => expectSilentFocus(visible));
    visible.blur();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(transitionTarget);
    expectKeyboardRing(transitionTarget);

    transitionTarget.setAttribute("aria-disabled", "true");
    await vi.waitFor(() => expectSilentFocus(transitionTarget));
  });
});
