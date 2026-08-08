import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { installFocusVisibility } from "../platform/focus-visibility";
import type { CaptureActionFeedback } from "../data/capture-command";
import { TrafficCaptureControl } from "./traffic-capture-control";
import "../styles.css";

const unavailableMessage = "Virtual Interface is not available in this version of Mish.";

const systemProxyStatus = {
  desired: false,
  failure: null,
  observed: "disabled" as const,
  phase: "off" as const,
  recoveryActions: [],
};

const tunStatus = {
  desired: false,
  failure: null,
  observation: null,
  observed: "disabled" as const,
  phase: "off" as const,
};

let root: Root;
let disposeFocusVisibility: () => void;
function renderHost(
  host: "Settings" | "Status",
  tun: "permission-required" | "repair-required" | "unavailable" = "unavailable",
  onTunHelperSetup?: (
    operation: "install" | "repair",
  ) => Promise<{ ok: true } | { ok: false; failure: null }>,
  locale: "en" | "zh" = "en",
  feedback?: CaptureActionFeedback,
) {
  const onTunChange = vi.fn();
  root.render(
    <TypesafeI18n key={`${locale}-${host}-${tun}`} locale={locale}>
      <MemoryRouter>
        <TooltipProvider>
          <section aria-label={host} className={host === "Settings" ? "max-w-60" : "max-w-120"}>
            <span className="sr-only" id="tun-unavailable-description">
              {unavailableMessage}
            </span>
            <span className="sr-only" id="tun-permission-description">
              Install, approve, or repair the Internal TUN service in Settings before using Virtual
              Interface.
            </span>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun }}
              commandSupported
              feedback={feedback}
              onSystemProxyChange={vi.fn()}
              onTunHelperSetup={onTunHelperSetup}
              onTunChange={onTunChange}
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={systemProxyStatus}
              tunEnabled={false}
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </section>
        </TooltipProvider>
      </MemoryRouter>
    </TypesafeI18n>,
  );
  return onTunChange;
}

beforeAll(async () => {
  loadAllLocales();
  disposeFocusVisibility = installFocusVisibility();
  document.body.innerHTML = '<div id="traffic-capture-control-browser-root"></div>';
  const container = document.getElementById("traffic-capture-control-browser-root");
  if (!container) throw new Error("Missing browser-test root");
  root = createRoot(container);
});

afterAll(() => {
  disposeFocusVisibility();
  root.unmount();
});

describe("Virtual Interface native setup boundary", () => {
  test("lets native RPC recheck an unavailable Virtual Interface in Status", async () => {
    const onTunChange = renderHost("Status");
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    await expect.element(tun).toBeEnabled();
    await userEvent.click(tun);
    expect(onTunChange).toHaveBeenCalledWith(true);
  });

  test("keeps the native recheck reason and focus path accessible in narrow Settings", async () => {
    renderHost("Settings");
    const systemProxy = page.getByRole("button", { name: /System Proxy, not selected/ });
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    await expect.element(tun).toHaveAccessibleDescription(unavailableMessage);
    await expect.element(tun).toBeEnabled();
    expect(document.querySelector("[data-capture-unavailable-trigger]")).toBeNull();

    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(systemProxy.element());
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(tun.element());
    await expect.element(tun).toHaveAttribute("data-mish-focus-visible", "keyboard");
    expect(getComputedStyle(tun.element()).outlineStyle).toBe("solid");
  });

  test("restores keyboard focus after cancelling the bounded setup explanation", async () => {
    const onTunChange = renderHost("Status", "permission-required");
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    await userEvent.keyboard("{Tab}");
    await userEvent.keyboard("{Tab}");
    await expect.element(tun).toHaveFocus();
    await expect.element(tun).toHaveAttribute("data-mish-focus-visible", "keyboard");
    expect(getComputedStyle(tun.element()).outlineStyle).toBe("solid");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("dialog", { name: "Before enabling Virtual Interface" }))
      .toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(tun).toHaveFocus();
    await expect.element(tun).not.toHaveAttribute("data-mish-focus-visible");
    expect(getComputedStyle(tun.element()).outlineStyle).toBe("none");
    expect(onTunChange).not.toHaveBeenCalled();
  });

  test("delegates repair and original TUN resumption to the native lifecycle", async () => {
    const setup = vi.fn(async () => ({ ok: true }) as const);
    const onTunChange = renderHost("Status", "repair-required", setup);
    const tun = page.getByRole("button", { name: /Virtual Interface, not selected/ });

    await userEvent.click(tun);
    await expect
      .element(page.getByRole("heading", { name: "Repair the system component" }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Repair System Component" }));

    await expect.poll(() => setup.mock.calls.length).toBe(1);
    expect(setup).toHaveBeenCalledWith("repair");
    expect(onTunChange).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("dialog", { name: "Before enabling Virtual Interface" }))
      .not.toBeInTheDocument();
  });

  test.each([
    {
      dialogTitle: "Before enabling Virtual Interface",
      locale: "en" as const,
      sectionTitle: "Install the system component",
      tun: "permission-required" as const,
    },
    {
      dialogTitle: "Before enabling Virtual Interface",
      locale: "en" as const,
      sectionTitle: "Repair the system component",
      tun: "repair-required" as const,
    },
    {
      dialogTitle: "启用虚拟网卡之前",
      locale: "zh" as const,
      sectionTitle: "安装系统组件",
      tun: "permission-required" as const,
    },
    {
      dialogTitle: "启用虚拟网卡之前",
      locale: "zh" as const,
      sectionTitle: "修复系统组件",
      tun: "repair-required" as const,
    },
  ])(
    "stacks $locale $tun setup copy at ordinary and narrow widths",
    async ({ dialogTitle, locale, sectionTitle, tun }) => {
      for (const [host, width] of [
        ["Status", 960],
        ["Settings", 320],
      ] as const) {
        await page.viewport(width, 680);
        renderHost(host, tun, undefined, locale);

        const trigger = page.getByRole("button", {
          name: locale === "en" ? /^Virtual Interface,/ : /^虚拟网卡，/,
        });
        await userEvent.click(trigger);

        const dialog = page.getByRole("dialog", { name: dialogTitle });
        await expect.element(dialog).toBeVisible();
        await expect.element(page.getByRole("heading", { name: sectionTitle })).toBeVisible();

        const dialogCopy = dialog
          .element()
          .querySelector<HTMLElement>("[data-tun-setup-dialog-copy]");
        const dialogTitleElement = dialog
          .element()
          .querySelector<HTMLElement>("[data-tun-setup-dialog-title]");
        const dialogDescription = dialog
          .element()
          .querySelector<HTMLElement>("[data-tun-setup-dialog-description]");
        const copy = dialog.element().querySelector<HTMLElement>("[data-tun-setup-copy]");
        const title = dialog.element().querySelector<HTMLElement>("[data-tun-setup-title]");
        const description = dialog
          .element()
          .querySelector<HTMLElement>("[data-tun-setup-description]");
        const actions = dialog.element().querySelector<HTMLElement>("[data-tun-setup-actions]");
        if (
          !dialogCopy ||
          !dialogTitleElement ||
          !dialogDescription ||
          !copy ||
          !title ||
          !description ||
          !actions
        ) {
          throw new Error("Missing setup explanation hierarchy");
        }

        expect(getComputedStyle(dialogCopy).display).toBe("flex");
        expect(getComputedStyle(dialogCopy).flexDirection).toBe("column");
        expect(dialogDescription.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          dialogTitleElement.getBoundingClientRect().bottom,
        );
        expect(getComputedStyle(copy).display).toBe("flex");
        expect(getComputedStyle(copy).flexDirection).toBe("column");
        expect(description.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          title.getBoundingClientRect().bottom,
        );
        expect(copy.scrollWidth).toBeLessThanOrEqual(copy.clientWidth + 1);
        expect(dialog.element().scrollWidth).toBeLessThanOrEqual(dialog.element().clientWidth + 1);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(getComputedStyle(actions).flexWrap).toBe(width === 320 ? "wrap" : "nowrap");

        const dialogBounds = dialog.element().getBoundingClientRect();
        for (const action of actions.querySelectorAll<HTMLElement>("button")) {
          const actionBounds = action.getBoundingClientRect();
          expect(actionBounds.left).toBeGreaterThanOrEqual(dialogBounds.left - 1);
          expect(actionBounds.right).toBeLessThanOrEqual(dialogBounds.right + 1);
        }

        await userEvent.keyboard("{Escape}");
        await expect.element(dialog).not.toBeInTheDocument();
      }
    },
  );
});

describe("Capture action feedback", () => {
  test.each(["Status", "Settings"] as const)(
    "keeps the %s action anatomy stable and blocked through finalization",
    async (host) => {
      renderHost(host, "unavailable", undefined, "en", {
        busy: true,
        failure: "listener-unavailable",
        operationId: "7",
        phase: "finalizing",
      });

      const systemProxy = page.getByRole("button", { name: /System Proxy, not selected/ });
      await expect.element(systemProxy).toBeDisabled();
      const finalizing = document.querySelector<HTMLElement>(
        '[data-capture-operation-phase="finalizing"]',
      );
      if (!finalizing?.id) throw new Error("Missing finalizing Capture action feedback");
      expect(finalizing).toHaveClass("sr-only");
      expect(finalizing).toHaveTextContent("Finishing the change");
      expect(finalizing).not.toHaveTextContent("System Proxy was not confirmed");
      expect(getComputedStyle(finalizing).position).toBe("absolute");
      expect(systemProxy.element().getAttribute("aria-describedby")).toContain(finalizing.id);
      const hostElement = document.querySelector<HTMLElement>(`[aria-label="${host}"]`);
      if (!hostElement) throw new Error(`Missing ${host} host`);
      const busyHeight = hostElement.getBoundingClientRect().height;

      renderHost(host, "unavailable", undefined, "en", {
        busy: false,
        failure: "listener-unavailable",
        operationId: "7",
        phase: "error",
      });
      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>("[data-capture-operation-phase]")?.dataset
              .captureOperationPhase,
        )
        .toBe("error");
      const terminal = document.querySelector<HTMLElement>(
        '[data-capture-operation-phase="error"]',
      );
      expect(terminal?.id).toBe(finalizing.id);
      expect(terminal).toBeEmptyDOMElement();
      expect(hostElement.getBoundingClientRect().height).toBe(busyHeight);
      await expect.element(systemProxy).toBeEnabled();
    },
  );
});
