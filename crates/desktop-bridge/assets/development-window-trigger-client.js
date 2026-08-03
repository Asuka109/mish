const capabilityPrefix = "#mish-desktop-window-trigger=";
const capabilityPattern = /^[A-Za-z0-9_-]{43}$/u;

function randomRequestId(crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function activateDevelopmentWindow({
  crypto,
  fetch,
  history,
  location,
  status,
}) {
  const fragment = location.hash;
  history.replaceState(null, "", location.pathname);
  const capability = fragment.startsWith(capabilityPrefix)
    ? fragment.slice(capabilityPrefix.length)
    : "";
  if (!capabilityPattern.test(capability)) {
    status.textContent = "This Mish desktop-window link is invalid or no longer available.";
    return false;
  }

  try {
    const response = await fetch(location.pathname, {
      body: JSON.stringify({
        capability,
        requestId: randomRequestId(crypto),
      }),
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      status.textContent = "This Mish desktop-window link expired or was already used.";
      return false;
    }
    status.textContent = "Mish is opening. You can close this page.";
    return true;
  } catch {
    status.textContent = "The Mish development backend is unavailable.";
    return false;
  }
}
