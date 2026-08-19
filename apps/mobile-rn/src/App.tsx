import { mishNativeTokens } from "@mish/design-tokens/native";
import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import {
  CAPABILITY_NAMES,
  capabilityClient,
  type CapabilityName,
  type CapabilitySnapshot,
} from "./native/capability-client";

const destinations = [
  { id: "home", label: "Home", description: "Daily control" },
  { id: "routes", label: "Routes", description: "Policy groups" },
  { id: "profiles", label: "Profiles", description: "Configuration" },
  { id: "activity", label: "Activity", description: "Traffic and events" },
  { id: "settings", label: "Settings", description: "Preferences" },
] as const;

function App() {
  const isDark = useColorScheme() === "dark";
  const [activeDestination, setActiveDestination] = useState("home");
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [selectedCapability, setSelectedCapability] = useState<CapabilityName>(CAPABILITY_NAMES[0]);

  useEffect(() => {
    void capabilityClient.getSnapshot().then(setSnapshot);
  }, []);

  const active = useMemo(
    () =>
      destinations.find((destination) => destination.id === activeDestination) ?? destinations[0],
    [activeDestination],
  );

  const refreshSnapshot = () => {
    void capabilityClient.getSnapshot().then(setSnapshot);
  };

  return (
    <SafeAreaView style={[styles.safeArea, isDark && styles.darkSafeArea]}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
      <View style={styles.root}>
        <View accessibilityRole="header" style={styles.topBar}>
          <View>
            <Text style={styles.eyebrow}>MISH</Text>
            <Text accessibilityRole="header" style={styles.title}>
              {active.label}
            </Text>
          </View>
          <Text style={styles.topBarHint}>React Native foundation</Text>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.heroCard}>
            <Text style={styles.cardEyebrow}>FOUNDATION STATUS</Text>
            <Text style={styles.heroTitle}>Native effects are not enabled</Text>
            <Text style={styles.bodyText}>
              This shell validates the typed capability boundary while VPN, TUN, Core, and socket
              protection remain unavailable.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh native capability state"
              onPress={refreshSnapshot}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            >
              <Text style={styles.primaryButtonText}>Refresh Capability State</Text>
            </Pressable>
          </View>

          <View accessibilityRole="summary" style={styles.section}>
            <Text style={styles.sectionTitle}>Capability Boundary</Text>
            <Text style={styles.bodyText}>
              {snapshot?.message ?? "Reading bounded native state…"}
            </Text>
            <View style={styles.capabilityList}>
              {CAPABILITY_NAMES.map((capability) => {
                const selected = selectedCapability === capability;
                return (
                  <Pressable
                    key={capability}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${capability} capability`}
                    onPress={() => setSelectedCapability(capability)}
                    style={({ pressed }) => [
                      styles.capabilityRow,
                      selected && styles.capabilityRowSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.capabilityCopy}>
                      <Text style={styles.capabilityName}>{capability}</Text>
                      <Text style={styles.caption}>Unavailable in foundation</Text>
                    </View>
                    <Text style={styles.statusText}>Unavailable</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </ScrollView>

        <View accessibilityRole="tablist" style={styles.bottomBar}>
          {destinations.map((destination) => {
            const selected = destination.id === activeDestination;
            return (
              <Pressable
                key={destination.id}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={destination.label}
                onPress={() => setActiveDestination(destination.id)}
                style={({ pressed }) => [
                  styles.tab,
                  selected && styles.tabSelected,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.tabLabel, selected && styles.tabLabelSelected]}>
                  {destination.label}
                </Text>
                <Text style={[styles.tabDescription, selected && styles.tabDescriptionSelected]}>
                  {destination.description}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: mishNativeTokens.color.surfaceSoft,
  },
  darkSafeArea: {
    backgroundColor: "#111113",
  },
  root: {
    flex: 1,
    backgroundColor: mishNativeTokens.color.canvas,
  },
  topBar: {
    minHeight: 76,
    paddingHorizontal: mishNativeTokens.spacing.pageGutterMobile,
    paddingVertical: mishNativeTokens.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: mishNativeTokens.color.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  eyebrow: {
    color: mishNativeTokens.color.brand,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  title: {
    color: mishNativeTokens.color.ink,
    fontSize: mishNativeTokens.typography.title.fontSize,
    fontWeight: "600",
    lineHeight: 29,
  },
  topBarHint: {
    maxWidth: 150,
    color: mishNativeTokens.color.muted,
    fontSize: mishNativeTokens.typography.caption.fontSize,
    textAlign: "right",
  },
  content: {
    padding: mishNativeTokens.spacing.pageGutterMobile,
    gap: mishNativeTokens.spacing.lg,
  },
  heroCard: {
    padding: mishNativeTokens.spacing.xl,
    gap: mishNativeTokens.spacing.sm,
    backgroundColor: mishNativeTokens.color.surfaceSoft,
    borderRadius: mishNativeTokens.radius.lg,
    borderWidth: 1,
    borderColor: mishNativeTokens.color.hairline,
  },
  cardEyebrow: {
    color: mishNativeTokens.color.brand,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.8,
  },
  heroTitle: {
    color: mishNativeTokens.color.ink,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "600",
  },
  bodyText: {
    color: mishNativeTokens.color.body,
    fontSize: mishNativeTokens.typography.body.fontSize,
    lineHeight: 21,
  },
  primaryButton: {
    minHeight: 44,
    marginTop: mishNativeTokens.spacing.sm,
    paddingHorizontal: mishNativeTokens.spacing.lg,
    borderRadius: mishNativeTokens.radius.md,
    backgroundColor: mishNativeTokens.color.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: mishNativeTokens.color.brandForeground,
    fontSize: mishNativeTokens.typography.metadata.fontSize,
    fontWeight: "600",
  },
  section: {
    gap: mishNativeTokens.spacing.sm,
  },
  sectionTitle: {
    color: mishNativeTokens.color.ink,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "600",
  },
  capabilityList: {
    gap: mishNativeTokens.spacing.xs,
  },
  capabilityRow: {
    minHeight: 56,
    paddingHorizontal: mishNativeTokens.spacing.md,
    paddingVertical: mishNativeTokens.spacing.sm,
    borderRadius: mishNativeTokens.radius.md,
    backgroundColor: mishNativeTokens.color.canvas,
    borderWidth: 1,
    borderColor: mishNativeTokens.color.hairline,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  capabilityRowSelected: {
    borderColor: mishNativeTokens.color.accent,
    backgroundColor: mishNativeTokens.color.interactive,
  },
  capabilityCopy: {
    flex: 1,
    gap: 2,
  },
  capabilityName: {
    color: mishNativeTokens.color.ink,
    fontSize: mishNativeTokens.typography.metadata.fontSize,
    fontWeight: "600",
  },
  caption: {
    color: mishNativeTokens.color.muted,
    fontSize: mishNativeTokens.typography.caption.fontSize,
  },
  statusText: {
    color: mishNativeTokens.color.warning,
    fontSize: mishNativeTokens.typography.caption.fontSize,
    fontWeight: "600",
  },
  bottomBar: {
    minHeight: 76,
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: mishNativeTokens.color.hairline,
    backgroundColor: mishNativeTokens.color.canvas,
    flexDirection: "row",
  },
  tab: {
    flex: 1,
    minHeight: 60,
    minWidth: 44,
    paddingHorizontal: 2,
    paddingVertical: 8,
    borderRadius: mishNativeTokens.radius.md,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  tabSelected: {
    backgroundColor: mishNativeTokens.color.interactive,
  },
  tabLabel: {
    color: mishNativeTokens.color.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  tabLabelSelected: {
    color: mishNativeTokens.color.brand,
  },
  tabDescription: {
    color: mishNativeTokens.color.mutedSoft,
    fontSize: 9,
    textAlign: "center",
  },
  tabDescriptionSelected: {
    color: mishNativeTokens.color.body,
  },
  pressed: {
    opacity: 0.72,
  },
});

export default App;
