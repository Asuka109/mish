import type {
  ProfileRouteCatalogDto,
  StatusConnectionState,
  StatusSnapshotDto,
} from "@mish/contracts";
import { useEffect, useState } from "react";
import { useOptionalProfiles } from "./profile-provider";

export function useConfiguredRouteCatalog(
  snapshot: StatusSnapshotDto | null,
  statusConnection: StatusConnectionState,
) {
  const profiles = useOptionalProfiles();
  const loadRoutes = profiles?.loadRoutes;
  const authority = profiles?.selectedProfileAuthority ?? null;
  const configuredAuthority =
    snapshot &&
    !statusConnection.stale &&
    (statusConnection.phase === "connected" || statusConnection.phase === "fixture") &&
    snapshot.groups.length === 0 &&
    snapshot.runtime.phase !== "healthy" &&
    authority
      ? authority
      : null;
  const configuredProfileId = configuredAuthority?.profileId ?? null;
  const configuredSelectionRevision = configuredAuthority?.selectionRevision ?? null;
  const configuredSemanticRevision = configuredAuthority?.semanticRevision ?? null;
  const authorityKey =
    configuredProfileId !== null &&
    configuredSelectionRevision !== null &&
    configuredSemanticRevision !== null
      ? JSON.stringify([
          configuredProfileId,
          configuredSelectionRevision,
          configuredSemanticRevision,
        ])
      : null;
  const [catalog, setCatalog] = useState<{
    authorityKey: string;
    catalog: ProfileRouteCatalogDto;
  } | null>(null);

  useEffect(() => {
    setCatalog(null);
    if (
      !configuredProfileId ||
      configuredSelectionRevision === null ||
      !configuredSemanticRevision ||
      !authorityKey ||
      !loadRoutes
    ) {
      return;
    }
    const controller = new AbortController();
    void loadRoutes(
      {
        profileId: configuredProfileId,
        selectionRevision: configuredSelectionRevision,
        semanticRevision: configuredSemanticRevision,
      },
      { signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted || !result.ok) return;
      setCatalog({ authorityKey, catalog: result.catalog });
    });
    return () => {
      controller.abort();
    };
  }, [
    authorityKey,
    configuredProfileId,
    configuredSelectionRevision,
    configuredSemanticRevision,
    loadRoutes,
  ]);

  return authorityKey !== null && catalog?.authorityKey === authorityKey ? catalog.catalog : null;
}
