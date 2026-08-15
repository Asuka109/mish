import React, { StrictMode, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { createStore, useMishStore } from "@mish/poc-query-store";

import {
  detectRuntimeCapabilities,
  replayAsyncIterableCancellation,
  replayWebSocketCancellation,
} from "./capabilities.ts";
import type { NativeCapabilitySnapshot } from "./native.ts";
import { getRnAdmissionModule } from "./native.ts";
import { RnTranscript } from "./transcript.ts";
import { replayXStateActor } from "./xstate.ts";

interface RendererState {
  readonly count: number;
  readonly phase: "booting" | "ready";
  readonly native: boolean;
  readonly capabilities: boolean;
}

export const rendererStore = createStore<RendererState>({
  count: 0,
  phase: "booting",
  native: false,
  capabilities: false,
});

export const rendererTranscript = new RnTranscript();

function RendererStoreProbe(): React.JSX.Element {
  const count = useMishStore(rendererStore, (state) => state.count);
  const phase = useMishStore(rendererStore, (state) => state.phase);

  useEffect(() => {
    rendererTranscript.record("renderer.mount", "accepted");
    rendererTranscript.record("store.subscribe", "accepted");
    if (rendererStore.getState().phase === "booting") {
      rendererStore.batch(() => {
        rendererStore.setState((previous) => ({ ...previous, count: 1 }));
        rendererStore.setState((previous) => ({ ...previous, count: previous.count + 1 }));
        rendererStore.setState((previous) => ({ ...previous, phase: "ready" }));
      });
      rendererTranscript.record("store.batch", "success");
    } else {
      rendererTranscript.record("store.remount", "success");
    }
    return () => {
      rendererTranscript.record("renderer.cleanup", "cleaned-up");
    };
  }, []);

  return (
    <Text testID="store-renderer-value">
      {`store:${phase}:${count}`}
    </Text>
  );
}

function AdmissionApp(): React.JSX.Element {
  const [nativeSnapshot, setNativeSnapshot] = useState<NativeCapabilitySnapshot | null>(null);
  const [nativeSmoke, setNativeSmoke] = useState(false);
  const [probeGeneration, setProbeGeneration] = useState(0);

  useEffect(() => {
    setProbeGeneration(1);
    let disposed = false;
    const module = getRnAdmissionModule();
    const runtime = detectRuntimeCapabilities();
    const capabilityReplay = new RnTranscript();
    const webSocket = replayWebSocketCancellation(capabilityReplay);
    const xstate = replayXStateActor(capabilityReplay);

    void (async () => {
      const [capabilities, smoke, iterable] = await Promise.all([
        module.getCapabilities(),
        module.smoke(),
        replayAsyncIterableCancellation(capabilityReplay),
      ]);
      const deterministic =
        capabilities.fixture === "deterministic" &&
        capabilities.newArchitecture &&
        capabilities.hermes &&
        !capabilities.vpnEffects &&
        !capabilities.tunEffects &&
        !capabilities.coreEffects &&
        !capabilities.networkEffects &&
        smoke === "native-capability-ok";
      const allReplays =
        webSocket.cancelled &&
        webSocket.reconnected &&
        iterable.abortObserved &&
        iterable.iteratorReturned &&
        iterable.querySinkSelected &&
        xstate &&
        runtime.asyncIterator;
      capabilityReplay.record("native.capabilities", deterministic && allReplays ? "available" : "unavailable");
      if (!disposed) {
        setNativeSnapshot(capabilities);
        setNativeSmoke(smoke === "native-capability-ok");
        rendererStore.setState((previous) => ({
          ...previous,
          native: deterministic,
          capabilities: allReplays,
        }));
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);

  const state = useMishStore(rendererStore);
  const admissionPassed =
    state.phase === "ready" &&
    state.count === 2 &&
    state.native &&
    state.capabilities &&
    nativeSnapshot !== null &&
    nativeSmoke;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mish React Native admission</Text>
      <RendererStoreProbe key={probeGeneration} />
      <Text testID="native-capability-value">
        {nativeSnapshot === null ? "native:pending" : "native:deterministic"}
      </Text>
      <Text testID="capability-value">{state.capabilities ? "capabilities:ready" : "capabilities:pending"}</Text>
      <Text accessibilityLabel="rn-admission-status" style={styles.status}>
        {admissionPassed ? "RN_ADMISSION_OK" : "RN_ADMISSION_PENDING"}
      </Text>
    </View>
  );
}

export default function App(): React.JSX.Element {
  return (
    <StrictMode>
      <AdmissionApp />
    </StrictMode>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#101827",
  },
  title: {
    color: "#f8fafc",
    fontSize: 20,
    marginBottom: 16,
  },
  status: {
    color: "#34d399",
    fontSize: 24,
    marginTop: 16,
  },
});
