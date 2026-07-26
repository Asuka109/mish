(() => {
  const root = document.documentElement;
  let preference = "system";

  try {
    const storedPreference = globalThis.localStorage?.getItem("mish.appearance");
    if (
      storedPreference === "light" ||
      storedPreference === "dark" ||
      storedPreference === "system"
    ) {
      preference = storedPreference;
    }
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }

  let systemAppearance = "light";
  if (preference === "system") {
    try {
      systemAppearance = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } catch {
      // A light placeholder is the safe fallback when media queries are unavailable.
    }
  }

  const appearance = preference === "system" ? systemAppearance : preference;
  if (root.dataset.theme !== appearance) {
    root.dataset.theme = appearance;
  }
  if (root.style.colorScheme !== appearance) {
    root.style.colorScheme = appearance;
  }

  const themeColor = document.querySelector('meta[name="theme-color"]');
  const themeColorValue = appearance === "dark" ? "#111113" : "#f8f9fa";
  if (themeColor?.getAttribute("content") !== themeColorValue) {
    themeColor?.setAttribute("content", themeColorValue);
  }
})();
