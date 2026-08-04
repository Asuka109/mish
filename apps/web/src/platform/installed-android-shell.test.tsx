import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  InstalledAndroidShellEntryBridge,
  isInstalledAndroidShellActive,
  parseInstalledAndroidShellEntry,
} from "./installed-android-shell";

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output>{`${location.pathname}${location.search}`}</output>
      <button onClick={() => navigate("/settings/network")}>Internal Web navigation</button>
    </>
  );
}

function renderBridge() {
  return render(
    <MemoryRouter initialEntries={["/status"]}>
      <InstalledAndroidShellEntryBridge />
      <Routes>
        <Route element={<LocationProbe />} path="*" />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  delete window.__MISH_ANDROID_SHELL_PENDING__;
  delete window.__MISH_ANDROID_SHELL_SNAPSHOT__;
  delete window.__MISH_APPLY_ANDROID_SHELL_ENTRY__;
  delete window.__MISH_INSTALLED_ANDROID_SHELL__;
});

describe("installed Android shell entry", () => {
  it("consumes the document-start bootstrap once and exposes no return callback", async () => {
    window.__MISH_INSTALLED_ANDROID_SHELL__ = true;
    window.__MISH_ANDROID_SHELL_PENDING__ = [
      {
        authorityId: "android-process-1",
        revision: 4,
        webEntryPath: "/events?source=notification",
      },
    ];
    renderBridge();

    expect(isInstalledAndroidShellActive()).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("/events?source=notification"),
    );
    expect(window.__MISH_ANDROID_SHELL_SNAPSHOT__).toMatchObject({ revision: 4 });
    expect(window.__MISH_ANDROID_SHELL_PENDING__).toEqual([]);
  });

  it("accepts only a newer entry from the same authority and replaces Web history", () => {
    renderBridge();
    const apply = window.__MISH_APPLY_ANDROID_SHELL_ENTRY__;
    expect(apply).toBeTypeOf("function");

    act(() => {
      apply?.({
        authorityId: "android-process-2",
        revision: 2,
        webEntryPath: "/settings/network?source=system",
      });
      apply?.({
        authorityId: "android-process-2",
        revision: 1,
        webEntryPath: "/profiles",
      });
    });

    expect(screen.getByRole("status")).toHaveTextContent("/settings/network?source=system");
    expect(window.__MISH_ANDROID_SHELL_SNAPSHOT__).toMatchObject({ revision: 2 });
  });

  it("leaves internal Web navigation entirely inside React Router", async () => {
    const user = userEvent.setup();
    renderBridge();
    act(() => {
      window.__MISH_APPLY_ANDROID_SHELL_ENTRY__?.({
        authorityId: "android-process-3",
        revision: 7,
        webEntryPath: "/settings",
      });
    });
    await user.click(screen.getByRole("button", { name: "Internal Web navigation" }));

    expect(screen.getByRole("status")).toHaveTextContent("/settings/network");
    expect(window.__MISH_ANDROID_SHELL_SNAPSHOT__).toMatchObject({
      revision: 7,
      webEntryPath: "/settings",
    });
  });

  it("rejects arbitrary, encoded-delimiter, stale-shape, and unknown entries", () => {
    for (const value of [
      null,
      { authorityId: "bad authority", revision: 0, webEntryPath: "/status" },
      { authorityId: "ok", revision: -1, webEntryPath: "/status" },
      { authorityId: "ok", revision: 0, webEntryPath: "/diagnostics" },
      { authorityId: "ok", revision: 0, webEntryPath: "/settings/%2fnetwork" },
      { authorityId: "ok", revision: 0, webEntryPath: "/settings#native" },
    ]) {
      expect(parseInstalledAndroidShellEntry(value)).toBeNull();
    }
  });
});
