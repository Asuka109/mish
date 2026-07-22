import { render, screen, waitFor } from "@testing-library/react";
import { Button, Toggle } from "@mish/ui";
import { describe, expect, it } from "vitest";

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("Button promise loading", () => {
  it("lets a caller override conflicting recipe utilities at the shared TV merge boundary", () => {
    render(
      <Button className="h-12 bg-red-500 px-6" variant="outline">
        Override
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Override" });
    expect(button).toHaveClass("h-12", "bg-red-500", "px-6");
    expect(button.className).not.toContain("h-8.5");
  });

  it("keeps Base UI pressed state semantic while the capture recipe styles it", () => {
    render(
      <Toggle data-capture-state="running" pressed variant="capture">
        System proxy
      </Toggle>,
    );

    const toggle = screen.getByRole("button", { name: "System proxy" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("data-capture-state", "running");
    expect(toggle).toHaveClass("data-[capture-state=running]:text-fg");
  });

  it("stays loading until a promise resolves", async () => {
    const operation = deferred();
    render(
      <Button loading={operation.promise} loadingText="Saving">
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".ui-spinner")).toBeInTheDocument();

    operation.resolve();

    await waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Save");
  });

  it("settles rejected promises and follows replacement promises", async () => {
    const first = deferred();
    const second = deferred();
    const { rerender } = render(<Button loading={first.promise}>Run</Button>);
    const button = screen.getByRole("button", { name: "Run" });

    rerender(<Button loading={second.promise}>Run</Button>);
    first.resolve();
    await Promise.resolve();
    expect(button).toHaveAttribute("aria-busy", "true");

    second.reject();
    await waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
    expect(button).toBeEnabled();
  });
});
