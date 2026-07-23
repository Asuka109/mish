import { AppShell } from "./components/app-shell";
import { ProductRoutes } from "./app-routes";
import { NotificationDeliveryProvider } from "./data/notification-delivery";
import type { NotificationClient } from "@mish/contracts";

export { RoutePending } from "./app-routes";

export function AppRoutes({ notificationClient }: { notificationClient?: NotificationClient }) {
  return (
    <NotificationDeliveryProvider client={notificationClient}>
      <ProductRoutes shell={<AppShell />} />
    </NotificationDeliveryProvider>
  );
}
