import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { useColors } from "@/contexts/ThemeContext";
import { prefetchBootstrapData } from "@/lib/api";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  const colors = useColors();

  return (
    <Stack
      screenOptions={{
        headerBackTitle: "Back",
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="alerts"
        options={{ title: "Alerts", presentation: "card" }}
      />
      <Stack.Screen
        name="alert-detail"
        options={{ title: "Alert Detail", presentation: "card" }}
      />
      <Stack.Screen
        name="family-members"
        options={{ title: "Family", presentation: "card" }}
      />
      <Stack.Screen
        name="device-details"
        options={{ title: "Device", presentation: "card" }}
      />
      <Stack.Screen
        name="welcome"
        options={{ headerShown: false, presentation: "card", gestureEnabled: false }}
      />
      <Stack.Screen
        name="signup"
        options={{ headerShown: false, presentation: "card" }}
      />
      <Stack.Screen
        name="onboarding"
        options={{ headerShown: false, presentation: "card", gestureEnabled: false }}
      />
      <Stack.Screen
        name="language-settings"
        options={{ title: "Language", presentation: "card" }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    const timeout = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
    (async () => {
      try {
        await Promise.race([prefetchBootstrapData(), timeout(3000)]);
      } catch {
        // Keep app startup resilient if bootstrap fails or is slow.
      } finally {
        if (!mounted) return;
        setReady(true);
        await SplashScreen.hideAsync();
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (!ready) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {Platform.OS === 'web' ? (
          <RootLayoutNav />
        ) : (
          <GestureHandlerRootView style={{ flex: 1 }}>
            <RootLayoutNav />
          </GestureHandlerRootView>
        )}
      </ThemeProvider>
    </QueryClientProvider>
  );
}
