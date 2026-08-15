import React, { StrictMode, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { MishQueryProvider, createQueryClient, createStore, useMishStore } from "@mish/ui-state";

import {
  detectRuntimeCapabilities,
  replayAsyncIterableCancellation,
  replayDomainActor,
  replayOrpcTransport,
} from "./capabilities.js";
import { getRnHostModule, type NativeCapabilitySnapshot } from "./native.js";
import { RnTranscript } from "./transcript.js";

interface PresentationState {
  readonly actor: boolean;
  readonly capabilities: boolean;
  readonly count: number;
  readonly iterator: boolean;
  readonly native: boolean;
  readonly phase: "booting" | "ready";
  readonly transport: boolean;
}

const INITIAL_PRESENTATION: PresentationState = {
  actor: false,
  capabilities: false,
  count: 0,
  iterator: false,
  native: false,
  phase: "booting",
  transport: false,
};

export const rendererStore = createStore<PresentationState>(INITIAL_PRESENTATION);
export const rendererTranscript = new RnTranscript();

function StoreProbe({ remountKey }: { readonly remountKey: number }): React.JSX.Element {
  const count = useMishStore(rendererStore, (state) => state.count);
  const phase = useMishStore(rendererStore, (state) => state.phase);

  useEffect(() => {
    rendererTranscript.record("renderer.mount", "event", "accepted");
    rendererTranscript.record("store.subscribe", "invocation", "accepted");
    if (rendererStore.getState().phase === "booting") {
      rendererStore.batch(() => {
        rendererStore.setState((previous) => ({ ...previous, count: 1 }));
        rendererStore.setState((previous) => ({ ...previous, count: previous.count + 1 }));
        rendererStore.setState((previous) => ({ ...previous, phase: "ready" }));
      });
      rendererTranscript.record("store.batch", "result", "success");
    } else {
      rendererTranscript.record("renderer.remount", "event", "accepted");
    }
    return () => {
      rendererTranscript.record("renderer.cleanup", "cleanup", "cleaned-up");
    };
  }, [remountKey]);

  return <Text testID="rn-store-renderer-value">{`store:${phase}:${count}`}</Text>;
}

function AdmissionApp(): React.JSX.Element {
  const [nativeSnapshot, setNativeSnapshot] = useState<NativeCapabilitySnapshot | null>(null);
  const [nativeSmoke, setNativeSmoke] = useState(false);
  const [surfaceGeneration, setSurfaceGeneration] = useState(0);
  const presentation = useMishStore(rendererStore);

  useEffect(() => {
    let disposed = false;
    const transcript = new RnTranscript();
    const runtime = detectRuntimeCapabilities();
    const native = getRnHostModule();

    void Promise.all([
      native.getCapabilities(),
      native.smoke(),
      replayAsyncIterableCancellation(transcript),
      replayDomainActor(transcript),
    ]).then(([capabilities, smoke, iterable, actor]) => {
      const transport = replayOrpcTransport(transcript);
      const nativeReady =
        capabilities.fixture === "deterministic" &&
        capabilities.newArchitecture &&
        capabilities.hermes &&
        !capabilities.vpnEffects &&
        !capabilities.tunEffects &&
        !capabilities.coreEffects &&
        !capabilities.networkEffects &&
        smoke === "native-capability-ok";
      const replayReady =
        iterable.abortObserved &&
        iterable.iteratorReturned &&
        iterable.querySinkSelected &&
        actor &&
        transport.cancelled &&
        transport.reconnected;
      const runtimeReady = runtime.asyncIterator && runtime.abortController;
      if (disposed) return undefined;
      setNativeSnapshot(capabilities);
      setNativeSmoke(nativeReady);
      rendererStore.setState((previous) => ({
        ...previous,
        actor,
        capabilities: replayReady && runtimeReady,
        iterator: iterable.iteratorReturned,
        native: nativeReady,
        transport: transport.cancelled && transport.reconnected,
      }));
      setSurfaceGeneration((generation) => generation + 1);
      return undefined;
    });

    return () => {
      disposed = true;
      rendererTranscript.record("renderer.cleanup", "cleanup", "cleaned-up");
    };
  }, []);

  const admissionPassed =
    presentation.phase === "ready" &&
    presentation.count === 2 &&
    presentation.actor &&
    presentation.capabilities &&
    presentation.iterator &&
    presentation.native &&
    presentation.transport &&
    nativeSnapshot !== null &&
    nativeSmoke;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mish React Native host</Text>
      <StoreProbe key={surfaceGeneration} remountKey={surfaceGeneration} />
      <Text testID="rn-native-capability-value">
        {nativeSnapshot === null ? "native:pending" : "native:deterministic"}
      </Text>
      <Text testID="rn-query-value">
        {presentation.capabilities ? "query:ready" : "query:pending"}
      </Text>
      <Text accessibilityLabel="rn-admission-status" style={styles.status}>
        {admissionPassed ? "RN_ADMISSION_OK" : "RN_ADMISSION_PENDING"}
      </Text>
    </View>
  );
}

const queryClient = createQueryClient({ queryRetry: 0, mutationRetry: 0 });

export default function App(): React.JSX.Element {
  return (
    <StrictMode>
      <MishQueryProvider client={queryClient}>
        <AdmissionApp />
      </MishQueryProvider>
    </StrictMode>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    backgroundColor: "#101827",
    flex: 1,
    justifyContent: "center",
    padding: 24,
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
