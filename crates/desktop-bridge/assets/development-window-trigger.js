import { activateDevelopmentWindow } from "/__openWindow-client.js";

const status = document.getElementById("mish-development-window-trigger-status");
if (status) {
  void activateDevelopmentWindow({
    crypto: window.crypto,
    fetch: window.fetch.bind(window),
    history: window.history,
    location: window.location,
    status,
  });
}
