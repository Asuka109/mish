import type { MobileFixtureBootstrapDto, MobileVpnSnapshotDto } from "@mish/contracts";
import { ProductRoutes } from "./app-routes";
import { MobileShell } from "./components/mobile-shell";
import type { MobileVpnClient } from "./platform/mobile-vpn-client";

export interface MobileAppRoutesProps {
  mobileFixture?: MobileFixtureBootstrapDto;
  mobileVpnClient?: MobileVpnClient;
  mobileVpnSnapshot?: MobileVpnSnapshotDto;
}

export function AppRoutes({
  mobileFixture,
  mobileVpnClient,
  mobileVpnSnapshot,
}: MobileAppRoutesProps) {
  if (!mobileFixture || !mobileVpnClient || !mobileVpnSnapshot) {
    throw new Error("Mobile routes require validated native fixture snapshots");
  }

  return (
    <ProductRoutes
      shell={
        <MobileShell
          fixture={mobileFixture}
          vpnClient={mobileVpnClient}
          vpnSnapshot={mobileVpnSnapshot}
        />
      }
    />
  );
}
