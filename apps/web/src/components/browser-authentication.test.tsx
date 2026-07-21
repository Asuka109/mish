import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { BrowserPairingError } from "../platform/runtime-bootstrap";
import { BrowserAuthentication } from "./browser-authentication";

loadAllLocales();

describe("browser authentication", () => {
  it("requests a local PIN and exchanges it before entering the product", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async () => ({
      challengeId: "a".repeat(64),
      expiresInSeconds: 120,
    }));
    const complete = vi.fn(async () => undefined);
    const onAuthenticated = vi.fn();

    render(
      <TypesafeI18n locale="en">
        <BrowserAuthentication
          complete={complete}
          onAuthenticated={onAuthenticated}
          request={request}
        />
      </TypesafeI18n>,
    );

    expect(await screen.findByLabelText("Six-digit PIN")).toBeVisible();
    expect(request).toHaveBeenCalledOnce();
    await user.type(screen.getByLabelText("Six-digit PIN"), "123456");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(complete).toHaveBeenCalledWith("a".repeat(64), "123456");
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("keeps an invalid PIN retryable without requesting another challenge", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async () => ({
      challengeId: "b".repeat(64),
      expiresInSeconds: 120,
    }));
    const complete = vi.fn(async () => {
      throw new BrowserPairingError("invalid");
    });

    render(
      <TypesafeI18n locale="en">
        <BrowserAuthentication complete={complete} request={request} />
      </TypesafeI18n>,
    );

    await user.type(await screen.findByLabelText("Six-digit PIN"), "654321");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("does not match");
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(request).toHaveBeenCalledOnce();
  });
});
