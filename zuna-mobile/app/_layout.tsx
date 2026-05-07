import '@/global.css';

import { NAV_THEME } from '@/lib/theme';
import { ThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useUniwind } from 'uniwind';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as JotaiProvider } from 'jotai';
import { jotaiStore, pushTokenAtom } from '@/store/atoms';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { registerDeviceWithAllServers } from '@/lib/notifications';

export { ErrorBoundary } from 'expo-router';

// Show notifications when app is in foreground (decryption happens in NSE for background)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
    mutations: { retry: 0 },
  },
});

function NotificationTokenListener() {
  useEffect(() => {
    const subscription = Notifications.addPushTokenListener(async ({ data: newToken }) => {
      jotaiStore.set(pushTokenAtom, newToken as string);
      await registerDeviceWithAllServers(newToken as string).catch(console.error);
    });
    return () => subscription.remove();
  }, []);
  return null;
}

export default function RootLayout() {
  const { theme } = useUniwind();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <JotaiProvider store={jotaiStore}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider value={NAV_THEME[theme ?? 'dark']}>
            <KeyboardProvider>
              <StatusBar style="light" />
              <NotificationTokenListener />
              <Stack screenOptions={{ headerShown: false }} />
              <PortalHost />
            </KeyboardProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </JotaiProvider>
    </GestureHandlerRootView>
  );
}
