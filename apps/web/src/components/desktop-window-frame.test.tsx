import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppearanceProvider } from "../appearance";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { BrowserAuthentication } from "./browser-authentication";
import { StartupFailure } from "./startup-failure";
import { DesktopWindowFrame } from "./desktop-window-frame";

loadAllLocales();

describe("DesktopWindowFrame", () => {
  it("mounts one non-focusable frame strip above the application composition on desktop", () => {
    const { container } = render(
      <DesktopWindowFrame runtime="desktop">
        <main>Application content</main>
      </DesktopWindowFrame>,
    );

    const frame = container.querySelector<HTMLElement>('[data-window-drag-surface="window-frame"]');
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(frame).toHaveAttribute("tabindex", "-1");
    expect(frame).toHaveClass("desktop-window-drag-surface");
  });

  it("keeps the shared frame strip when the startup failure replaces AppShell", () => {
    const { container } = render(
      <DesktopWindowFrame runtime="desktop">
        <AppearanceProvider>
          <TypesafeI18n locale="en">
            <StartupFailure />
          </TypesafeI18n>
        </AppearanceProvider>
      </DesktopWindowFrame>,
    );

    expect(screen.getByRole("alert")).toBeVisible();
    expect(container.querySelector('[data-window-drag-surface="window-frame"]')).not.toBeNull();
    expect(container.querySelector('[data-window-drag-surface="window-frame"]')).not.toHaveClass(
      "startup-failure",
    );
  });

  it("keeps the shared frame strip when browser authentication replaces AppShell", () => {
    const { container } = render(
      <DesktopWindowFrame runtime="desktop">
        <AppearanceProvider>
          <TypesafeI18n locale="en">
            <BrowserAuthentication
              complete={async () => undefined}
              onAuthenticated={() => undefined}
              request={async () => ({ challengeId: "challenge", expiresInSeconds: 60 })}
            />
          </TypesafeI18n>
        </AppearanceProvider>
      </DesktopWindowFrame>,
    );

    expect(container.querySelector(".browser-authentication")).not.toBeNull();
    expect(container.querySelector('[data-window-drag-surface="window-frame"]')).not.toBeNull();
  });

  it("does not add an invisible drag strip in browser or mobile runtimes", () => {
    const { container, rerender } = render(
      <DesktopWindowFrame runtime="browser">
        <main>Browser content</main>
      </DesktopWindowFrame>,
    );
    expect(container.querySelector('[data-window-drag-surface="window-frame"]')).toBeNull();

    rerender(
      <DesktopWindowFrame runtime="mobile">
        <main>Mobile content</main>
      </DesktopWindowFrame>,
    );
    expect(container.querySelector('[data-window-drag-surface="window-frame"]')).toBeNull();
  });
});
