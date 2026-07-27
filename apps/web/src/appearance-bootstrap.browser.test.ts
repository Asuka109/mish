import { afterEach, describe, expect, test } from "vitest";

const csp =
  "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; object-src 'none'";

function loadStartupDocument(preference: string | null) {
  if (preference === null) {
    localStorage.removeItem("mish.appearance");
  } else {
    localStorage.setItem("mish.appearance", preference);
  }

  const frame = document.createElement("iframe");
  frame.srcdoc = `<!doctype html>
    <html>
      <head>
        <meta http-equiv="Content-Security-Policy" content="${csp}">
        <meta name="theme-color" content="#f8f9fa">
        <style>
          html, body, #root { min-height: 100%; margin: 0; }
          .startup-placeholder { background: #f8f9fa; position: fixed; inset: 0; }
          html[data-theme="dark"] .startup-placeholder { background: #111113; }
        </style>
        <script src="/appearance-bootstrap.js"></script>
      </head>
      <body>
        <div id="root"><div class="startup-placeholder">Loading</div></div>
      </body>
    </html>`;
  document.body.append(frame);

  return new Promise<HTMLIFrameElement>((resolve, reject) => {
    frame.addEventListener("load", () => resolve(frame), { once: true });
    frame.addEventListener("error", () => reject(new Error("Startup fixture failed")), {
      once: true,
    });
  });
}

afterEach(() => {
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
  localStorage.clear();
});

describe("startup appearance under self-only CSP", () => {
  test.each([
    ["light", "light"],
    ["dark", "dark"],
    ["malformed", "light"],
    [null, "light"],
  ] as const)("renders %s storage as a %s first frame", async (preference, expected) => {
    const frame = await loadStartupDocument(preference);
    const frameDocument = frame.contentDocument;
    const placeholder = frameDocument?.querySelector<HTMLElement>(".startup-placeholder");

    expect(frameDocument?.documentElement.dataset.theme).toBe(expected);
    expect(frameDocument?.documentElement.style.colorScheme).toBe(expected);
    expect(getComputedStyle(placeholder!).backgroundColor).toBe(
      expected === "dark" ? "rgb(17, 17, 19)" : "rgb(248, 249, 250)",
    );
  });

  test("resolves follow-system in the browser and keeps the theme through React handoff", async () => {
    const frame = await loadStartupDocument("system");
    const frameDocument = frame.contentDocument!;
    const expected = frame.contentWindow!.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";

    expect(frameDocument.documentElement.dataset.theme).toBe(expected);
    frameDocument
      .querySelector("#root")!
      .replaceChildren(
        Object.assign(frameDocument.createElement("main"), { textContent: "React application" }),
      );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(frameDocument.documentElement.dataset.theme).toBe(expected);
    expect(frameDocument.querySelector("main")?.textContent).toBe("React application");
  });

  test("uses an executable external initializer and no executable inline entry script", async () => {
    const response = await fetch("/");
    const entryDocument = new DOMParser().parseFromString(await response.text(), "text/html");
    const scripts = [...entryDocument.querySelectorAll("script")];

    expect(
      scripts.some((script) => script.getAttribute("src") === "/appearance-bootstrap.js"),
    ).toBe(true);
    expect(scripts.filter((script) => !script.hasAttribute("src"))).toHaveLength(0);
  });

  test("keeps the static placeholder motionless when reduced motion is requested", async () => {
    const frame = await loadStartupDocument("dark");
    const placeholder = frame.contentDocument!.querySelector<HTMLElement>(".startup-placeholder")!;

    expect(frame.contentWindow!.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    expect(getComputedStyle(placeholder).animationName).toBe("none");
    expect(getComputedStyle(placeholder).transitionDuration).toBe("0s");
  });
});
