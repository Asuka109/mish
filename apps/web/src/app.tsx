import { AppShell } from "./components/app-shell";
import { ProductRoutes } from "./app-routes";
import { NotificationDeliveryProvider } from "./data/notification-delivery";

export { RoutePending } from "./app-routes";

export function AppRoutes() {
  return (
    <NotificationDeliveryProvider>
      <ProductRoutes shell={<AppShell />} />
    </NotificationDeliveryProvider>
  );
}
