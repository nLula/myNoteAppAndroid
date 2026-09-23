import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Pressable } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as NavigationBar from 'expo-navigation-bar';
import NoteListScreen from './screens/NoteListScreen';
import EditorScreen from './screens/EditorScreen';
import ViewScreen from './screens/ViewScreen';
import TagsScreen from './screens/TagsScreen';
import SettingsScreen from './screens/SettingsScreen';
import { ThemeProvider, useThemeCtx } from './themeContext';
import { getConfig } from './lib/github';
import { getActiveProvider } from './lib/syncProvider';
import { runSync } from './lib/syncStatus';

const Stack = createNativeStackNavigator();

function useAutoSync() {
  useEffect(() => {
    let lastRun = 0;
    const tick = setInterval(async () => {
      try {
        const provider = await getActiveProvider();
        const cfg = await getConfig();
        const connected = provider === 'github' ? cfg.connected : false;
        const sinceLastRun = Math.round((Date.now() - lastRun) / 1000);
        console.log(`[autosync] provider=${provider} connected=${connected} interval=${cfg.syncInterval}s sinceLastRun=${sinceLastRun}s`);
        if (!connected || cfg.syncInterval <= 0) return;
        if (Date.now() - lastRun >= cfg.syncInterval * 1000) {
          lastRun = Date.now();
          console.log('[autosync] → firing runSync');
          runSync().catch((e: any) => console.warn('[autosync] runSync error:', e?.message));
        }
      } catch (e: any) {
        console.warn('[autosync] tick error:', e?.message);
      }
    }, 10000);
    return () => clearInterval(tick);
  }, []);
}

function Root() {
  const { theme: t, isDark, themeMode, toggleTheme } = useThemeCtx();
  useAutoSync();

  useEffect(() => {
    try {
      NavigationBar.setStyle(t.dark ? 'light' : 'dark');
    } catch {}
  }, [t]);

  const navTheme = {
    ...(t.dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(t.dark ? DarkTheme.colors : DefaultTheme.colors),
      background: t.bgBase,
      card: t.bgSurface,
      text: t.textPrimary,
      border: t.border,
      primary: t.accent,
    },
  };

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: t.bgSurface },
          headerTintColor: t.textPrimary,
        }}
      >
        <Stack.Screen name="Notes" component={NoteListScreen} options={{ headerShown: false }} />
        <Stack.Screen name="View" component={ViewScreen} options={{ headerStyle: { backgroundColor: t.bgSurface } }} />
        <Stack.Screen name="Editor" component={EditorScreen} options={{ headerStyle: { backgroundColor: t.bgSurface } }} />
        <Stack.Screen name="Tags" component={TagsScreen} options={{ headerStyle: { backgroundColor: t.bgSurface } }} />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            title: 'Settings',
            headerRight: () => (
              <Pressable onPress={toggleTheme} style={{ padding: 6 }}>
                <Feather
                  name={themeMode === 'light' ? 'sun' : themeMode === 'dark' ? 'moon' : 'smartphone'}
                  size={20}
                  color={t.textMuted}
                />
              </Pressable>
            ),
          }}
        />
      </Stack.Navigator>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Root />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
