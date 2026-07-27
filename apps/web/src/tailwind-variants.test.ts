import { cn } from "@mish/ui/tv";
import { describe, expect, it } from "vitest";

describe("configured Tailwind Variants merge boundary", () => {
  it("applies semantic typography configuration before any recipe is created", () => {
    expect(cn("text-title", "text-fg")).toBe("text-title text-fg");
    expect(cn("text-title", "text-body", "text-fg")).toBe("text-body text-fg");
    expect(cn("text-title", "text-sm", "text-fg")).toBe("text-sm text-fg");
  });
});
