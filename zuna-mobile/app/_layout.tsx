import '@/global.css';

import { NAV_THEME } from '@/lib/theme';
import { ThemeProvider } from '@react-navigation/native';
import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useUniwind } from 'uniwind';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as JotaiProvider } from 'jotai';
import { jotaiStore } from '@/store/atoms';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';

export { ErrorBoundary } from 'expo-router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
    mutations: { retry: 0 },
  },
});

export default function RootLayout() {
  const { theme } = useUniwind();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <JotaiProvider store={jotaiStore}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider value={NAV_THEME[theme ?? 'dark']}>
            <KeyboardProvider>
              <StatusBar style="light" />
              <Stack screenOptions={{ headerShown: false }} />
              <PortalHost />
            </KeyboardProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </JotaiProvider>
    </GestureHandlerRootView>
  );
}
