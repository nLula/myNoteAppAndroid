import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DarkTheme, DefaultTheme, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AppState, Pressable } from 'react-native';
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
import { runSync, isSyncing } from './lib/syncStatus';
import { ensureScratchNote } from './notes';

const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef<any>();

// Shortest gap between the syncs fired when the app leaves or re-enters the
// foreground. A quiet sync is one API call and a few seconds of hashing, so
// this can be short; it exists to stop rapid app-switching stacking them up.
const EDGE_SYNC_THROTTLE_MS = 30000;

/**
 * Open straight into the scratch note, on top of the note list so Back still
 * reaches it. Runs once per launch — onReady fires when the container mounts,
 * not on re-render or when the app returns from the background.
 */
function openScratchNote() {
  try {
    const { name, caret } = ensureScratchNote();
    navigationRef.navigate('Editor', caret === null ? { name } : { name, startOffset: caret });
  } catch (e: any) {
    console.warn('[scratch] could not open the blank note:', e?.message);
  }
}

function useAutoSync() {
  useEffect(() => {
    let lastRun = 0;

    // Sync as soon as the app opens rather than waiting out the first tick. The
    // app launches straight into a note, so until this lands the screen is
    // showing whatever the last session left on disk. Deliberately a beat late:
    // hashing every note blocks JS for a couple of seconds, and doing that
    // during the opening frames makes the launch stutter. The editor swaps in
    // the pulled text when this finishes.
    const launchSync = setTimeout(async () => {
      try {
        const provider = await getActiveProvider();
        const cfg = await getConfig();
        if (provider !== 'github' || !cfg.connected || cfg.syncInterval <= 0) return;
        if (isSyncing()) return;
        lastRun = Date.now();
        console.log('[autosync] app opened → syncing before showing stale text');
        await runSync();
        console.log('[autosync] launch sync finished');
      } catch (e: any) {
        console.warn('[autosync] launch sync failed:', e?.message);
      }
    }, 600);

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

    // The scheduled tick only runs while the app is in the foreground, so both
    // edges of a foreground session deserve a sync of their own:
    //
    //   leaving  → push what was just written, while the app is still alive.
    //              Best effort: once swiped away Android may kill the process
    //              mid-upload. Nothing is corrupted either way — a write lands
    //              or it doesn't — and the next sync carries whatever didn't.
    //   resuming → pull what another device changed while we were away, rather
    //              than showing stale notes until the next tick.
    //
    // Both edges share one throttle, so bouncing between apps doesn't start a
    // sync every few seconds. Sharing it is also correct: runSync is
    // bidirectional, so a push seconds ago already collected remote changes.
    let lastEdgeRun = 0;
    const sub = AppState.addEventListener('change', (state) => {
      const resuming = state === 'active';
      if (Date.now() - lastEdgeRun < EDGE_SYNC_THROTTLE_MS) return;
      lastEdgeRun = Date.now();
      const what = resuming ? 'resume' : 'background';
      (async () => {
        try {
          const provider = await getActiveProvider();
          const cfg = await getConfig();
          // Honour "Never": that setting means manual-only, edges included.
          if (provider !== 'github' || !cfg.connected || cfg.syncInterval <= 0) return;
          if (isSyncing()) return;
          console.log(`[autosync] app ${resuming ? 'resumed → pulling from' : 'leaving foreground → pushing to'} GitHub`);
          lastRun = Date.now();
          await runSync();
          console.log(`[autosync] ${what} sync finished`);
        } catch (e: any) {
          console.warn(`[autosync] ${what} sync did not finish:`, e?.message);
        }
      })();
    });

    return () => { clearTimeout(launchSync); clearInterval(tick); sub.remove(); };
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
    <NavigationContainer ref={navigationRef} theme={navTheme} onReady={openScratchNote}>
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
