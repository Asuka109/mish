import type {
  MobileFixtureBootstrapDto,
  MobileVpnSnapshotDto,
  NotificationClient,
} from "@mish/contracts";
import { ProductRoutes } from "./app-routes";
import { MobileShell } from "./components/mobile-shell";
import { NotificationDeliveryProvider } from "./data/notification-delivery";
import { MobileHomePage } from "./pages/mobile-home-page";
import {
  MobileRouteChildPage,
  MobileRouteGroupPage,
  MobileRoutesPage,
} from "./pages/mobile-routes-page";
import type { MobileVpnClient } from "./platform/mobile-vpn-client";

export interface MobileAppRoutesProps {
  mobileFixture?: MobileFixtureBootstrapDto;
  mobileVpnClient?: MobileVpnClient;
  mobileVpnSnapshot?: MobileVpnSnapshotDto;
  notificationClient?: NotificationClient;
}

export function AppRoutes({
  mobileFixture,
  mobileVpnClient,
  mobileVpnSnapshot,
  notificationClient,
}: MobileAppRoutesProps) {
  if (!mobileFixture || !mobileVpnClient || !mobileVpnSnapshot) {
    throw new Error("Mobile routes require validated native fixture snapshots");
  }

  return (
    <NotificationDeliveryProvider client={notificationClient}>
      <ProductRoutes
        routesChildElement={<MobileRouteChildPage />}
        routesElement={<MobileRoutesPage />}
        routesGroupElement={<MobileRouteGroupPage />}
        shell={<MobileShell fixture={mobileFixture} />}
        statusElement={
          <MobileHomePage
            fixture={mobileFixture}
            initialSnapshot={mobileVpnSnapshot}
            vpnClient={mobileVpnClient}
          />
        }
      />
    </NotificationDeliveryProvider>
  );
}
