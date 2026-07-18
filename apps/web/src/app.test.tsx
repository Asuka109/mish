import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mish/ui";
import {
  StatusClientError,
  type CaptureSelectionDto,
  type RoutingMode,
  type StatusClient,
  type StatusSnapshotDto,
} from "@mish/contracts";
import { AppRoutes } from "./app";
import { AppearanceProvider } from "./appearance";
import { FixtureStatusClient } from "./data/fixture-status-client";
import { ProductProvider } from "./data/product-provider";
import TypesafeI18n from "./i18n/i18n-react";
import type { Locales } from "./i18n/i18n-types";
import { loadAllLocales } from "./i18n/i18n-util.sync";

loadAllLocales();

function renderRoute(path: string, locale: Locales = "en", client?: StatusClient) {
  return render(
    <AppearanceProvider>
      <TypesafeI18n locale={locale}>
        <MemoryRouter initialEntries={[path]}>
          <ProductProvider client={client}>
            <TooltipProvider>
              <AppRoutes />
            </TooltipProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

class DeferredRoutingClient extends FixtureStatusClient {
  calls = 0;
  rejectCommand: (() => void) | null = null;

  override setRoutingMode(_mode: RoutingMode) {
    this.calls += 1;
    return new Promise<Awaited<ReturnType<FixtureStatusClient["getSnapshot"]>>>((_, reject) => {
      this.rejectCommand = () =>
        reject(new StatusClientError("conflict", "Routing command failed", true));
    });
  }
}

class FailingServicesClient extends FixtureStatusClient {
  override restoreDefaultServices(): Promise<StatusSnapshotDto> {
    return Promise.reject(new StatusClientError("remote", "Restore failed"));
  }
}

class FailingCaptureClient extends FixtureStatusClient {
  override setCapture(
    _selection: CaptureSelectionDto,
    _active: boolean,
  ): Promise<StatusSnapshotDto> {
    return Promise.reject(new StatusClientError("remote", "Capture failed"));
  }
}

describe("production routes", () => {
  it("presents Mish as the product brand", () => {
    renderRoute("/status");
    const brandImages = screen.getByLabelText("Mish").querySelectorAll("img");
    expect(brandImages).toHaveLength(2);
    expect(brandImages[0]).toHaveAttribute("src", "/brand/mish-brand.svg");
    expect(brandImages[1]).toHaveAttribute("src", "/brand/mish-brand-dark.svg");
  });

  it.each([
    ["/status", "Status"],
    ["/routes", "Routes"],
    ["/profiles", "Profiles"],
    ["/traffic", "Traffic"],
    ["/events", "Events"],
    ["/settings", "Settings"],
  ])("renders %s as a direct deep link", async (path, title) => {
    renderRoute(path);
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
  });

  it("uses semantic links and preserves an accessible active destination", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    const routesLink = screen.getByRole("link", { name: "Routes" });
    expect(routesLink).toHaveAttribute("href", "/routes");
    await user.click(routesLink);
    expect(await screen.findByRole("heading", { name: "Routes" })).toBeInTheDocument();
    expect(routesLink).toHaveAttribute("aria-current", "page");
  });

  it("starts with fixture data without opening a socket or making a request", async () => {
    const webSocket = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("WebSocket", webSocket);
    vi.stubGlobal("fetch", fetch);

    renderRoute("/status");
    await screen.findByText("Fixture activity at a glance.");

    expect(webSocket).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Status fixture experience", () => {
  it("labels fixture state and renders opaque Unicode labels verbatim", async () => {
    renderRoute("/status");
    expect(await screen.findByText("Fixture activity at a glance.")).toBeInTheDocument();
    expect(screen.getByText("Demo mode")).toBeInTheDocument();
    expect(screen.getByText("🌐 Proxy")).toBeInTheDocument();
    expect(screen.getByText("Messaging")).toBeInTheDocument();
  });

  it("changes routing and one group child through the typed fixture adapter", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    await screen.findByText("Fixture activity at a glance.");

    const globalMode = screen.getByRole("button", { name: "Global" });
    await user.click(globalMode);
    await waitFor(() => expect(globalMode).toHaveAttribute("aria-pressed", "true"));

    await user.click(screen.getByRole("button", { name: /🌐 Proxy/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByText("🇯🇵 NRT-03"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /🌐 Proxy/ })).toHaveTextContent(
        "🇯🇵 NRT-03 · 71 ms",
      );
    });
  });

  it("keeps capture actions explicitly described as fixture-only", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    const stopButton = await screen.findByRole("button", { name: "Disable the proxy demo state" });
    expect(stopButton).toHaveAccessibleDescription(/local fixture data only/);
    await user.click(stopButton);
    expect(
      await screen.findByRole("button", { name: "Enable the proxy demo state" }),
    ).toBeInTheDocument();
  });

  it("remembers selected capture modes when the master control stops and resumes capture", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    const systemProxy = await screen.findByRole("button", { name: /^System Proxy/ });
    expect(systemProxy).toHaveAttribute("aria-pressed", "true");
    expect(systemProxy).toHaveAccessibleName("System Proxy, selected, running");

    await user.click(screen.getByRole("button", { name: "Disable the proxy demo state" }));

    await waitFor(() => {
      expect(systemProxy).toHaveAttribute("aria-pressed", "true");
      expect(systemProxy).toHaveAccessibleName("System Proxy, selected, not running");
    });

    await user.click(screen.getByRole("button", { name: "Enable the proxy demo state" }));

    await waitFor(() => {
      expect(systemProxy).toHaveAccessibleName("System Proxy, selected, running");
    });
  });

  it("starts the complete remembered combination when a stopped unselected mode is added", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    await user.click(await screen.findByRole("button", { name: "Disable the proxy demo state" }));
    const systemProxy = screen.getByRole("button", {
      name: "System Proxy, selected, not running",
    });
    const tun = screen.getByRole("button", {
      name: "Virtual Interface, not selected, not running",
    });

    await user.click(tun);

    await waitFor(() => {
      expect(systemProxy).toHaveAccessibleName("System Proxy, selected, running");
      expect(tun).toHaveAccessibleName("Virtual Interface, selected, running");
    });
  });

  it("removes a remembered mode without starting capture when its gray control is clicked", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    await user.click(await screen.findByRole("button", { name: "Disable the proxy demo state" }));
    await user.click(
      screen.getByRole("button", {
        name: "Virtual Interface, not selected, not running",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Disable the proxy demo state" }));
    await user.click(screen.getByRole("button", { name: "System Proxy, selected, not running" }));

    expect(
      await screen.findByRole("button", { name: "System Proxy, not selected, not running" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Virtual Interface, selected, not running" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Enable the proxy demo state" })).toHaveAttribute(
      "title",
      "Start proxy with Virtual Interface",
    );
  });

  it("uses System Proxy as the master-control fallback when no mode is selected", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    await user.click(
      await screen.findByRole("button", { name: "System Proxy, selected, running" }),
    );
    expect(
      await screen.findByRole("button", { name: "System Proxy, not selected, not running" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Enable the proxy demo state" })).toHaveAttribute(
      "title",
      "Start proxy with System Proxy",
    );

    await user.click(screen.getByRole("button", { name: "Enable the proxy demo state" }));

    expect(
      await screen.findByRole("button", { name: "System Proxy, selected, running" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("does not remember an unconfirmed capture-mode change", async () => {
    const user = userEvent.setup();
    renderRoute("/status", "en", new FailingCaptureClient());

    await user.click(
      await screen.findByRole("button", {
        name: "Virtual Interface, not selected, not running",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("The command failed.");
    expect(screen.getByRole("button", { name: "System Proxy, selected, running" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", {
        name: "Virtual Interface, not selected, not running",
      }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("prevents duplicate commands while pending and preserves confirmed state on failure", async () => {
    const user = userEvent.setup();
    const client = new DeferredRoutingClient();
    renderRoute("/status", "en", client);
    await screen.findByText("Fixture activity at a glance.");
    const globalMode = screen.getByRole("button", { name: "Global" });

    await user.click(globalMode);
    expect(globalMode).toBeDisabled();
    await user.click(globalMode);
    expect(client.calls).toBe(1);

    client.rejectCommand?.();
    expect(await screen.findByRole("alert")).toHaveTextContent("The command failed.");
    await waitFor(() => expect(globalMode).not.toBeDisabled());
    expect(globalMode).toHaveAttribute("aria-pressed", "false");
  });

  it("does not show a success toast after a failed service command", async () => {
    const user = userEvent.setup();
    const successToast = vi.spyOn(toast, "success");
    renderRoute("/status", "en", new FailingServicesClient());
    await screen.findByText("Fixture activity at a glance.");

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("menuitem", { name: "Restore defaults" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The command failed.");
    expect(successToast).not.toHaveBeenCalled();
  });

  it("switches to Simplified Chinese and persists the locale", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    await screen.findByText("Fixture activity at a glance.");

    await user.click(
      screen.getByRole("button", { name: "Change language. Current language: English" }),
    );
    await user.click(await screen.findByRole("menuitemradio", { name: "简体中文" }));

    expect(await screen.findByText("当前演示活动概览。")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "路由" })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
    expect(localStorage.getItem("mish.locale")).toBe("zh");
  });

  it("switches appearance manually and persists the preference", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    await screen.findByText("Fixture activity at a glance.");

    await user.click(
      screen.getByRole("button", { name: "Change theme. Current theme: Follow system" }),
    );
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("mish.appearance")).toBe("dark");
    expect(screen.getByRole("button", { name: "Change theme. Current theme: Dark" })).toBeVisible();
  });

  it("defers service validation feedback until a field is edited", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    await screen.findByText("Fixture activity at a glance.");

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add service" }));

    const title = await screen.findByRole("textbox", { name: "Title" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(title).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(title, "Temporary");
    await user.clear(title);

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a title.");
    expect(title).toHaveAttribute("aria-invalid", "true");
  });
});
