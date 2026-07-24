import { useEffect, useRef } from "react";
import { notificationPublication, useNotificationDelivery } from "../data/notification-delivery";
import { useOptionalProfiles } from "../data/profile-provider";
import { useProduct } from "../data/product-provider";
import { useOptionalSettings } from "../data/settings-provider";
import { useOptionalTraffic } from "../data/traffic-provider";

/** TypeScript-only producers cross the canonical Rust publication Interface here. */
export function NotificationPublicationController() {
  const { publish, retire } = useNotificationDelivery();
  const settings = useOptionalSettings();
  const traffic = useOptionalTraffic();
  const profiles = useOptionalProfiles();
  const { error, localProxyTest, snapshot } = useProduct();
  const geodataProgress = useRef(new Map<string, { key: string; type: GeodataProgressType }>());
  const welcomePromptPending = useRef(false);
  const welcomeInvitation = settings?.snapshot.preferences.onboarding.welcomeInvitation;
  const activation = profiles?.snapshot?.activation;
  const systemProxy = snapshot?.runtime.systemProxy;
  const tun = snapshot?.runtime.tun;
  const fixture = snapshot?.adapterKind === "fixture";

  useEffect(() => {
    if (!welcomeInvitation) return;
    if (!settings) return;
    if (welcomeInvitation.promptedAt !== null) {
      publish(
        notificationPublication("onboarding.welcome", {
          dedupeKey: "onboarding.welcome",
          params: { prompt: false },
          severity: "info",
        }),
      );
      return;
    }
    if (welcomePromptPending.current) return;
    welcomePromptPending.current = true;
    void settings.setOnboardingWelcomeState("prompt").then((prompted) => {
      welcomePromptPending.current = false;
      if (!prompted) return;
      publish(
        notificationPublication("onboarding.welcome", {
          dedupeKey: "onboarding.welcome",
          params: { prompt: true },
          severity: "info",
        }),
      );
    });
  }, [publish, retire, settings, welcomeInvitation]);

  useEffect(() => {
    if (!fixture) return;
    if (activation?.phase !== "pending" || activation.evidence?.kind !== "geodata-preparing") {
      const failure =
        activation?.phase === "failure" &&
        (activation.evidence?.kind === "geodata-failed" ||
          activation.evidence?.kind === "geodata-timeout")
          ? activation.evidence
          : null;
      if (failure && !geodataProgress.current.has(failure.asset)) {
        geodataProgress.current.set(failure.asset, {
          key: geodataNotificationKey(activation?.commandId, failure.asset),
          type: geodataProgressType(failure.asset),
        });
      }
      for (const [asset, progress] of geodataProgress.current) {
        if (asset === failure?.asset) {
          publish(
            notificationPublication(geodataFailureType(failure.asset), {
              dedupeKey: progress.key,
              params: {
                asset,
                outcome: failure.kind === "geodata-timeout" ? "timeout" : "failed",
              },
              replaces: ["status.operation-failed"],
              severity: "error",
            }),
          );
          continue;
        }
        publish(
          notificationPublication(progress.type, {
            dedupeKey: progress.key,
            params: { asset },
            pinned: false,
            resolved: true,
            severity: "success",
          }),
        );
      }
      geodataProgress.current.clear();
      return;
    }
    const asset = activation.evidence.asset;
    const type = geodataProgressType(asset);
    const key = geodataNotificationKey(activation.commandId, asset);
    geodataProgress.current.set(asset, { key, type });
    publish(
      notificationPublication(type, {
        dedupeKey: key,
        params: { asset },
        pinned: true,
        severity: "info",
      }),
    );
  }, [activation?.evidence, activation?.phase, fixture, publish, retire]);

  useEffect(() => {
    const outcome =
      localProxyTest.phase === "failure"
        ? "rpc-failure"
        : localProxyTest.phase === "success"
          ? localProxyTest.result.phase
          : null;
    if (!outcome) {
      retire("local-proxy.feedback");
      return;
    }
    const severity =
      outcome === "ready"
        ? "success"
        : outcome === "core-unhealthy" || outcome === "runtime-transition"
          ? "warning"
          : "error";
    publish(
      notificationPublication("local-proxy.feedback", {
        dedupeKey: "local-proxy.feedback",
        params: { outcome },
        severity,
      }),
    );
  }, [localProxyTest, publish, retire]);

  useEffect(() => {
    if (!fixture) return;
    if (!error || activation?.failure === "managed-listener-conflict") {
      retire("status.operation-failed");
      return;
    }
    publish(
      notificationPublication("status.operation-failed", {
        dedupeKey: "status.operation-failed",
        severity: "error",
      }),
    );
  }, [activation?.failure, error, fixture, publish, retire]);

  useEffect(() => {
    if (!fixture) return;
    if (systemProxy?.phase !== "drift") {
      retire("system-proxy.drift");
      return;
    }
    const repairRequiresCore =
      systemProxy.recoveryActions.includes("repair") && snapshot?.runtime.phase !== "healthy";
    publish(
      notificationPublication("system-proxy.drift", {
        dedupeKey: "system-proxy.drift",
        params: {
          canLeave: systemProxy.recoveryActions.includes("leave-as-is"),
          canRepair: systemProxy.recoveryActions.includes("repair") && !repairRequiresCore,
          failure: systemProxy.failure,
          repairRequiresCore,
        },
        severity: "warning",
      }),
    );
  }, [fixture, publish, retire, snapshot?.runtime.phase, systemProxy]);

  useEffect(() => {
    if (!fixture) return;
    if (systemProxy?.phase !== "failed") {
      retire("system-proxy.failed");
      return;
    }
    publish(
      notificationPublication("system-proxy.failed", {
        dedupeKey: "system-proxy.failed",
        params: { failure: systemProxy.failure },
        severity: "error",
      }),
    );
  }, [fixture, publish, retire, systemProxy]);

  useEffect(() => {
    if (!fixture) return;
    if (tun?.phase !== "drift" && tun?.phase !== "failed") {
      retire("tun.state-warning");
      return;
    }
    publish(
      notificationPublication(tun.phase === "drift" ? "tun.drift" : "tun.failed", {
        dedupeKey: "tun.state-warning",
        severity: tun.phase === "drift" ? "warning" : "error",
      }),
    );
  }, [fixture, publish, retire, tun?.phase]);

  useEffect(() => {
    if (!fixture) return;
    if (!settings?.error) {
      retire("settings.operation-failed");
      return;
    }
    publish(
      notificationPublication("settings.operation-failed", {
        dedupeKey: "settings.operation-failed",
        severity: "error",
      }),
    );
  }, [fixture, publish, retire, settings?.error]);

  useEffect(() => {
    if (!fixture) return;
    if (!traffic?.commandFailure) {
      retire("traffic.operation-failed");
      return;
    }
    publish(
      notificationPublication("traffic.operation-failed", {
        dedupeKey: "traffic.operation-failed",
        params: { failure: traffic.commandFailure },
        severity: "error",
      }),
    );
  }, [fixture, publish, retire, traffic?.commandFailure]);

  useEffect(() => {
    if (!fixture) return;
    if (activation?.failure !== "managed-listener-conflict") {
      retire("profile.activation-failure");
      return;
    }
    publish(
      notificationPublication("profile.activation-listener-conflict", {
        dedupeKey: "profile.activation-failure",
        params: { endpoint: activation.failureEndpoint ?? "127.0.0.1" },
        replaces: ["status.operation-failed"],
        severity: "error",
      }),
    );
  }, [activation?.failure, activation?.failureEndpoint, fixture, publish, retire]);

  return null;
}

type GeodataProgressType =
  | "profile.activation-asn-progress"
  | "profile.activation-geoip-progress"
  | "profile.activation-geosite-progress"
  | "profile.activation-mmdb-progress";

type GeodataFailureType =
  | "profile.activation-asn-failed"
  | "profile.activation-geoip-failed"
  | "profile.activation-geosite-failed"
  | "profile.activation-mmdb-failed";

type GeodataAsset = "asn" | "geo-ip" | "geo-site" | "mmdb";

function geodataNotificationKey(commandId: string | null | undefined, asset: GeodataAsset) {
  return `profile.activation-geodata:${commandId ?? "fixture"}:${asset}`;
}

function geodataProgressType(asset: GeodataAsset): GeodataProgressType {
  switch (asset) {
    case "asn":
      return "profile.activation-asn-progress";
    case "geo-ip":
      return "profile.activation-geoip-progress";
    case "geo-site":
      return "profile.activation-geosite-progress";
    case "mmdb":
      return "profile.activation-mmdb-progress";
  }
}

function geodataFailureType(asset: GeodataAsset): GeodataFailureType {
  switch (asset) {
    case "asn":
      return "profile.activation-asn-failed";
    case "geo-ip":
      return "profile.activation-geoip-failed";
    case "geo-site":
      return "profile.activation-geosite-failed";
    case "mmdb":
      return "profile.activation-mmdb-failed";
  }
}
