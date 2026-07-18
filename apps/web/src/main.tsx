import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Toaster } from "sonner";
import { TooltipProvider } from "@mish/ui";
import { AppRoutes } from "./app";
import { AppearanceProvider, useAppearance } from "./appearance";
import { ProductProvider } from "./data/product-provider";
import TypesafeI18n from "./i18n/i18n-react";
import { loadAllLocales } from "./i18n/i18n-util.sync";
import { persistLocale, resolveInitialLocale } from "./i18n/locale";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const initialLocale = resolveInitialLocale();
loadAllLocales();
persistLocale(initialLocale);

function AppearanceToaster() {
  const { resolvedAppearance } = useAppearance();
  return <Toaster position="bottom-right" theme={resolvedAppearance} />;
}

createRoot(root).render(
  <StrictMode>
    <AppearanceProvider>
      <TypesafeI18n locale={initialLocale}>
        <BrowserRouter>
          <ProductProvider>
            <TooltipProvider delay={500}>
              <AppRoutes />
              <AppearanceToaster />
            </TooltipProvider>
          </ProductProvider>
        </BrowserRouter>
      </TypesafeI18n>
    </AppearanceProvider>
  </StrictMode>,
);
