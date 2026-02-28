import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Colors from "@/constants/colors";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: "Back",
        headerStyle: { backgroundColor: Colors.background },
        headerTintColor: Colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: Colors.background },
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
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <GestureHandlerRootView>
        <RootLayoutNav />
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}
