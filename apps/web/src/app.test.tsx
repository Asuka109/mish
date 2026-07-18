import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@mihomo/ui";
import { AppRoutes } from "./app";
import { ProductProvider } from "./data/product-provider";
import TypesafeI18n from "./i18n/i18n-react";
import type { Locales } from "./i18n/i18n-types";
import { loadAllLocales } from "./i18n/i18n-util.sync";

loadAllLocales();

function renderRoute(path: string, locale: Locales = "en") {
  return render(
    <TypesafeI18n locale={locale}>
      <MemoryRouter initialEntries={[path]}>
        <ProductProvider>
          <TooltipProvider>
            <AppRoutes />
          </TooltipProvider>
        </ProductProvider>
      </MemoryRouter>
    </TypesafeI18n>,
  );
}

describe("production routes", () => {
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
    expect(localStorage.getItem("mihomo-web-client.locale")).toBe("zh");
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
