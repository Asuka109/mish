import { beforeEach, describe, expect, it } from "vitest";
import { revealStartupSurface } from "./window-startup";

describe("startup surface", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="startup-placeholder"></div>';
  });

  it("removes the loading marker after the renderer mounts", () => {
    revealStartupSurface();

    expect(document.querySelector(".startup-placeholder")).not.toBeInTheDocument();
  });

  it("leaves unrelated document content untouched", () => {
    document.body.insertAdjacentHTML("beforeend", '<div data-testid="application"></div>');

    revealStartupSurface();

    expect(document.querySelector('[data-testid="application"]')).toBeInTheDocument();
  });
});
