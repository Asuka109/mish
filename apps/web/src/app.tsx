import { AppShell } from "./components/app-shell";
import { ProductRoutes } from "./app-routes";

export { RoutePending } from "./app-routes";

export function AppRoutes() {
  return <ProductRoutes shell={<AppShell />} />;
}
