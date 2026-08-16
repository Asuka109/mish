import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CutoverWebComposition } from "./data/cutover-composition";
import { AppRoutes } from "./app";
import { BrowserAuthenticationRequired, resolveWebStartup } from "./platform/runtime-bootstrap";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const reactRoot = createRoot(root);

async function startApplication() {
  try {
    const startup = await resolveWebStartup();
    reactRoot.render(
      <StrictMode>
        <CutoverWebComposition session={startup.session}>
          <AppRoutes />
        </CutoverWebComposition>
      </StrictMode>,
    );
  } catch (error) {
    reactRoot.render(
      <StrictMode>
        <main className="min-h-screen bg-canvas p-8 text-ink" data-startup-state="authentication">
          <h1 className="text-title font-semibold">Mish</h1>
          <p className="mt-2 text-body text-muted-foreground">
            {error instanceof BrowserAuthenticationRequired
              ? "Authentication is required before opening the oRPC session."
              : "The oRPC session could not be admitted."}
          </p>
        </main>
      </StrictMode>,
    );
  }
}

void startApplication();
