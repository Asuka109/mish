import type { ProfileRouteCatalogDto, StatusSnapshotDto } from "@mish/contracts";
import { useEffect, useState } from "react";
import { useOptionalProfiles } from "./profile-provider";

export function useConfiguredRouteCatalog(snapshot: StatusSnapshotDto | null) {
  const profiles = useOptionalProfiles();
  const loadRoutes = profiles?.loadRoutes;
  const selectionRevision = profiles?.selectedProfileRevision ?? 0;
  const configuredProfileId =
    snapshot &&
    snapshot.groups.length === 0 &&
    snapshot.runtime.phase !== "healthy" &&
    profiles?.selectedProfileId
      ? profiles.selectedProfileId
      : null;
  const [catalog, setCatalog] = useState<{
    catalog: ProfileRouteCatalogDto;
    selectionRevision: number;
  } | null>(null);

  useEffect(() => {
    if (!configuredProfileId || !loadRoutes) {
      setCatalog(null);
      return;
    }
    let cancelled = false;
    void loadRoutes(configuredProfileId).then((result) => {
      if (cancelled || !result.ok) return;
      setCatalog({ catalog: result.catalog, selectionRevision });
    });
    return () => {
      cancelled = true;
    };
  }, [configuredProfileId, loadRoutes, selectionRevision]);

  return configuredProfileId !== null &&
    catalog?.catalog.profileId === configuredProfileId &&
    catalog.selectionRevision === selectionRevision
    ? catalog.catalog
    : null;
}
