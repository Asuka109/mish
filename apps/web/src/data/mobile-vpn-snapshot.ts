import type { MobileVpnSnapshotDto } from "@mish/contracts";
import { useEffect, useState } from "react";
import type { MobileVpnClient } from "../platform/mobile-vpn-client";

/** React retains only the latest snapshot already accepted by the native client. */
export function useMobileVpnSnapshot(
  vpnClient: MobileVpnClient,
  initialSnapshot: MobileVpnSnapshotDto,
) {
  const [snapshot, setSnapshot] = useState(() => vpnClient.getSnapshot() ?? initialSnapshot);

  useEffect(() => {
    setSnapshot(vpnClient.getSnapshot() ?? initialSnapshot);
    return vpnClient.subscribe(setSnapshot);
  }, [initialSnapshot, vpnClient]);

  return snapshot;
}
