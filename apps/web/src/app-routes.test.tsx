import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TypesafeI18n from "./i18n/i18n-react";
import { loadAllLocales } from "./i18n/i18n-util.sync";
import {
  DeferredRoute,
  RouteRecovery,
  routeRetryLimit,
  type RouteModuleLoader,
} from "./app-routes";

loadAllLocales();

afterEach(() => {
  vi.restoreAllMocks();
});

function silenceReactErrorLogging() {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function renderRouteRecovery(children: ReactNode, locale: "en" | "zh" = "en") {
  return render(
    <TypesafeI18n locale={locale}>
      <MemoryRouter initialEntries={["/traffic"]}>{children}</MemoryRouter>
    </TypesafeI18n>,
  );
}

describe("localized route recovery", () => {
  it("recovers from a lazy-route load failure with a bounded retry", async () => {
    silenceReactErrorLogging();
    const user = userEvent.setup();
    let attempts = 0;
    const LoadedRoute = () => <h1>Loaded route</h1>;
    const loader: RouteModuleLoader = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient module failure");
      return { default: LoadedRoute };
    };

    renderRouteRecovery(<DeferredRoute loader={loader} />, "zh");

    expect(await screen.findByRole("alert")).toHaveTextContent("页面暂不可用");
    expect(screen.getByRole("button", { name: "重试" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("heading", { name: "Loaded route" })).toBeInTheDocument();
    expect(attempts).toBe(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("recovers from a render failure without changing the current route", async () => {
    silenceReactErrorLogging();
    const user = userEvent.setup();
    let shouldFail = true;
    function FlakyRoute() {
      if (shouldFail) throw new Error("render failure");
      return <h1>Recovered route</h1>;
    }

    renderRouteRecovery(
      <>
        <RouteRecovery>
          <FlakyRoute />
        </RouteRecovery>
        <span data-testid="route-marker">/traffic</span>
      </>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Destination unavailable");
    shouldFail = false;
    await user.click(screen.getByRole("button", { name: "Try Again" }));

    expect(await screen.findByRole("heading", { name: "Recovered route" })).toBeInTheDocument();
    expect(screen.getByTestId("route-marker")).toHaveTextContent("/traffic");
  });

  it("stops retrying after the route retry limit and keeps the escape link reachable", async () => {
    silenceReactErrorLogging();
    const user = userEvent.setup();
    let attempts = 0;
    function PermanentlyBrokenRoute(): ReactNode {
      throw new Error("permanent render failure");
    }
    const loader: RouteModuleLoader = async () => {
      attempts += 1;
      return { default: PermanentlyBrokenRoute };
    };

    renderRouteRecovery(<DeferredRoute loader={loader} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
    for (let retry = 0; retry < routeRetryLimit; retry += 1) {
      await user.click(screen.getByRole("button", { name: "Try Again" }));
      await waitFor(() => {
        const alert = screen.getByRole("alert");
        if (retry + 1 === routeRetryLimit) {
          expect(alert).toHaveTextContent(
            "This destination could not recover after the available retries.",
          );
        } else {
          expect(alert).toHaveTextContent("Mish could not load this destination.");
        }
      });
    }

    expect(attempts).toBe(routeRetryLimit + 1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This destination could not recover after the available retries.",
    );
    expect(screen.queryByRole("button", { name: "Try Again" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to Status" })).toHaveAttribute(
      "href",
      "/status",
    );
  });
});
