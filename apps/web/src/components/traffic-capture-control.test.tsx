import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mish/ui";
import { MemoryRouter } from "react-router";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { TrafficCaptureControl } from "./traffic-capture-control";
import type { TunHelperOperationResult } from "../data/settings-provider";

loadAllLocales();

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

function renderControl(onSystemProxyChange = vi.fn()) {
  return render(
    <MemoryRouter>
      <TypesafeI18n locale="en">
        <TooltipProvider>
          <TrafficCaptureControl
            adapterKind="fixture"
            capabilities={{ systemProxy: "fixture-only", tun: "fixture-only" }}
            commandSupported
            onSystemProxyChange={onSystemProxyChange}
            onTunChange={vi.fn()}
            systemProxyEnabled={false}
            systemProxySelected={false}
            systemProxyStatus={systemProxyStatus}
            tunEnabled={false}
            tunSelected={false}
            tunStatus={tunStatus}
          />
        </TooltipProvider>
      </TypesafeI18n>
    </MemoryRouter>,
  );
}

describe("TrafficCaptureControl Virtual Interface boundary", () => {
  it("keeps Virtual Interface disabled while exposing its explanation on focus", async () => {
    const user = userEvent.setup();
    renderControl();

    const unavailableTrigger = document.querySelector<HTMLElement>(
      "[data-capture-unavailable-trigger]",
    );
    if (!unavailableTrigger) throw new Error("Missing unavailable Virtual Interface trigger");
    const tun = screen.getByRole("button", { name: /Virtual Interface, not selected/ });

    expect(tun).toBeDisabled();
    expect(unavailableTrigger).toHaveAccessibleName("Virtual Interface");
    expect(unavailableTrigger).toHaveAttribute("aria-describedby", "tun-unavailable-description");

    unavailableTrigger.focus();
    await screen.findByText("Virtual Interface is not available in this version of Mish.");
    await user.keyboard("{Enter}");

    expect(tun).toBeDisabled();
  });

  it("opens Helper setup before requesting a permission-required Virtual Interface", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "permission-required" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunChange={onTunChange}
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={systemProxyStatus}
              tunEnabled={false}
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </TooltipProvider>
        </TypesafeI18n>
      </MemoryRouter>,
    );

    const tun = screen.getByRole("button", { name: /Virtual Interface, not selected/ });
    expect(tun).toBeEnabled();
    expect(tun).toHaveAttribute("aria-describedby", "tun-permission-description");

    await user.click(tun);
    expect(screen.getByRole("dialog", { name: "Before enabling Virtual Interface" })).toBeVisible();
    expect(screen.getByText("Install the system component")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeVisible();
    expect(onTunChange).not.toHaveBeenCalled();
  });

  it.each([
    {
      action: "Install System Component",
      description:
        "macOS will ask for permission so Mish can install the system component that Virtual Interface needs. Virtual Interface stays off while Mish checks the component. Once it is ready, Mish continues your request to enable Virtual Interface.",
      dialogTitle: "Before enabling Virtual Interface",
      locale: "en" as const,
      sectionTitle: "Install the system component",
      tun: "permission-required" as const,
    },
    {
      action: "Repair System Component",
      description:
        "macOS will ask for permission so Mish can repair the system component that Virtual Interface needs. Virtual Interface stays off while Mish checks the component. Once it is ready, Mish continues your request to enable Virtual Interface.",
      dialogTitle: "Before enabling Virtual Interface",
      locale: "en" as const,
      sectionTitle: "Repair the system component",
      tun: "repair-required" as const,
    },
    {
      action: "安装系统组件",
      description:
        "需要 macOS 管理员授权，Mish 才能安装虚拟网卡所需的系统组件。检查期间，虚拟网卡会保持关闭；确认组件准备就绪后，Mish 会继续这次启用请求。",
      dialogTitle: "启用虚拟网卡之前",
      locale: "zh" as const,
      sectionTitle: "安装系统组件",
      tun: "permission-required" as const,
    },
    {
      action: "修复系统组件",
      description:
        "需要 macOS 管理员授权，Mish 才能修复虚拟网卡所需的系统组件。检查期间，虚拟网卡会保持关闭；确认组件准备就绪后，Mish 会继续这次启用请求。",
      dialogTitle: "启用虚拟网卡之前",
      locale: "zh" as const,
      sectionTitle: "修复系统组件",
      tun: "repair-required" as const,
    },
  ])(
    "presents $locale $tun setup with user-facing copy in a vertical hierarchy",
    async ({ action, description, dialogTitle, locale, sectionTitle, tun }) => {
      const user = userEvent.setup();
      const setup = vi.fn(async (): Promise<TunHelperOperationResult> => ({ ok: true }));
      const onTunChange = vi.fn();
      render(
        <MemoryRouter>
          <TypesafeI18n locale={locale}>
            <TooltipProvider>
              <TrafficCaptureControl
                adapterKind="rpc"
                capabilities={{ systemProxy: "supported", tun }}
                commandSupported
                onSystemProxyChange={vi.fn()}
                onTunHelperSetup={setup}
                onTunChange={onTunChange}
                systemProxyEnabled={false}
                systemProxySelected={false}
                systemProxyStatus={systemProxyStatus}
                tunEnabled={false}
                tunSelected={false}
                tunStatus={tunStatus}
              />
            </TooltipProvider>
          </TypesafeI18n>
        </MemoryRouter>,
      );

      await user.click(
        screen.getByRole("button", {
          name: locale === "en" ? /^Virtual Interface,/ : /^虚拟网卡，/,
        }),
      );

      const dialog = screen.getByRole("dialog", { name: dialogTitle });
      const dialogCopy = dialog.querySelector<HTMLElement>("[data-tun-setup-dialog-copy]");
      const dialogDescription = dialog.querySelector<HTMLElement>(
        "[data-tun-setup-dialog-description]",
      );
      const dialogTitleElement = dialog.querySelector<HTMLElement>("[data-tun-setup-dialog-title]");
      const title = screen.getByRole("heading", { name: sectionTitle });
      const copy = title.parentElement;
      const detail = screen.getByText(description);
      if (!dialogCopy || !dialogDescription || !dialogTitleElement || !copy) {
        throw new Error("Missing setup explanation hierarchy");
      }

      expect(dialog).toBeVisible();
      expect(screen.getByRole("button", { name: action })).toBeVisible();
      expect(dialogCopy).toHaveClass("flex", "flex-col");
      expect(
        dialogTitleElement.compareDocumentPosition(dialogDescription) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(copy).toHaveAttribute("data-tun-setup-copy");
      expect(copy).toHaveClass("flex", "flex-col");
      expect(title.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(dialog).not.toHaveTextContent("same macOS authorization flow");
      expect(dialog).not.toHaveTextContent("fresh disabled network observation");
      expect(dialog).not.toHaveTextContent("同一套 macOS 授权流程");
      expect(dialog).not.toHaveTextContent("网络状态为关闭");
      expect(setup).not.toHaveBeenCalled();
      expect(onTunChange).not.toHaveBeenCalled();
    },
  );

  it("lets the native lifecycle resume the original Capture request after Helper installation", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    const setup = vi.fn(
      async (): Promise<TunHelperOperationResult> => ({
        ok: true,
      }),
    );
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "permission-required" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunHelperSetup={setup}
              onTunChange={onTunChange}
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={systemProxyStatus}
              tunEnabled={false}
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </TooltipProvider>
        </TypesafeI18n>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    await user.click(screen.getByRole("button", { name: "Install System Component" }));

    await waitFor(() => expect(setup).toHaveBeenCalledWith("install"));
    expect(onTunChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Before enabling Virtual Interface" })).toBeNull();
  });

  it("keeps the original lifecycle action retryable after a failed setup changes the capability", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    const setup = vi
      .fn<() => Promise<TunHelperOperationResult>>()
      .mockResolvedValueOnce({ failure: "authorization-cancelled", ok: false })
      .mockResolvedValueOnce({ ok: true });
    function control(tun: "permission-required" | "unavailable") {
      return (
        <MemoryRouter>
          <TypesafeI18n locale="en">
            <TooltipProvider>
              <TrafficCaptureControl
                adapterKind="rpc"
                capabilities={{ systemProxy: "supported", tun }}
                commandSupported
                onSystemProxyChange={vi.fn()}
                onTunHelperSetup={setup}
                onTunChange={onTunChange}
                systemProxyEnabled={false}
                systemProxySelected={false}
                systemProxyStatus={systemProxyStatus}
                tunEnabled={false}
                tunSelected={false}
                tunStatus={tunStatus}
              />
            </TooltipProvider>
          </TypesafeI18n>
        </MemoryRouter>
      );
    }

    const { rerender } = render(control("permission-required"));

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    await user.click(screen.getByRole("button", { name: "Install System Component" }));

    await waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
    expect(onTunChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(control("unavailable"));
    expect(screen.getByRole("button", { name: "Install System Component" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Install System Component" }));
    await waitFor(() => expect(setup).toHaveBeenCalledTimes(2));
    expect(onTunChange).not.toHaveBeenCalled();
  });

  it("uses the shared repair lifecycle and leaves Capture resumption to Rust", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    const setup = vi.fn(
      async (): Promise<TunHelperOperationResult> => ({
        ok: true,
      }),
    );
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "repair-required" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunHelperSetup={setup}
              onTunChange={onTunChange}
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={systemProxyStatus}
              tunEnabled={false}
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </TooltipProvider>
        </TypesafeI18n>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    expect(screen.getByText("Repair the system component")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Repair System Component" }));

    await waitFor(() => expect(setup).toHaveBeenCalledWith("repair"));
    expect(onTunChange).not.toHaveBeenCalled();
  });

  it("uses the authoritative Capture path when the Helper projection is supported", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "supported" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunChange={onTunChange}
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={systemProxyStatus}
              tunEnabled={false}
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </TooltipProvider>
        </TypesafeI18n>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));

    expect(screen.queryByRole("dialog", { name: "Before enabling Virtual Interface" })).toBeNull();
    expect(onTunChange).toHaveBeenCalledWith(true);
  });

  it("announces pending state only for the requested Capture mode", () => {
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "supported" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunChange={vi.fn()}
              pending
              pendingMode="tun"
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={{
                desired: false,
                failure: null,
                observed: "disabled",
                phase: "off",
                recoveryActions: [],
              }}
              tunEnabled={false}
              tunSelected
              tunStatus={{ ...tunStatus, desired: true, phase: "pending" }}
            />
          </TooltipProvider>
        </TypesafeI18n>
      </MemoryRouter>,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("System Proxy is off and confirmed by macOS.");
    expect(status).toHaveTextContent("Virtual Interface is waiting for helper confirmation.");
    expect(status).not.toHaveTextContent("System Proxy is pending macOS confirmation.");
  });

  it("leaves System Proxy actionable", async () => {
    const user = userEvent.setup();
    const onSystemProxyChange = vi.fn();
    renderControl(onSystemProxyChange);

    await user.click(screen.getByRole("button", { name: /System Proxy, not selected/ }));

    expect(onSystemProxyChange).toHaveBeenCalledOnce();
    expect(onSystemProxyChange.mock.calls[0]?.[0]).toBe(true);
  });

  it("makes Virtual Interface actionable only for a supported native RPC projection", async () => {
    const user = userEvent.setup();
    const onTunChange = vi.fn();
    render(
      <MemoryRouter>
        <TypesafeI18n locale="en">
          <TooltipProvider>
            <TrafficCaptureControl
              adapterKind="rpc"
              capabilities={{ systemProxy: "supported", tun: "supported" }}
              commandSupported
              onSystemProxyChange={vi.fn()}
              onTunChange={onTunChange}
              systemProxyEnabled={false}
              systemProxySelected={false}
              systemProxyStatus={systemProxyStatus}
              tunEnabled={false}
              tunSelected={false}
              tunStatus={tunStatus}
            />
          </TooltipProvider>
        </TypesafeI18n>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Virtual Interface, not selected/ }));
    expect(onTunChange).toHaveBeenCalledOnce();
    expect(onTunChange.mock.calls[0]?.[0]).toBe(true);
  });
});
