import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { darkTheme, lightTheme, Theme } from './theme';

const STORAGE_KEY = 'mynote_theme_override';

export type ThemeMode = 'light' | 'dark' | 'auto';
type Ctx = { theme: Theme; isDark: boolean; themeMode: ThemeMode; toggleTheme: () => void };

const ThemeCtx = createContext<Ctx>({ theme: darkTheme, isDark: true, themeMode: 'dark', toggleTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  // Start in auto so the first render already matches the system — no flash.
  const [themeMode, setThemeMode] = useState<ThemeMode>('auto');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((v) => {
      if (v === 'light') setThemeMode('light');
      else if (v === 'dark') setThemeMode('dark');
      else setThemeMode('auto');
    });
  }, []);

  function toggleTheme() {
    setThemeMode((prev) => {
      const next: ThemeMode = prev === 'light' ? 'dark' : prev === 'dark' ? 'auto' : 'light';
      AsyncStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }

  const isDark = themeMode === 'dark' || (themeMode === 'auto' && systemScheme === 'dark');
  const theme = isDark ? darkTheme : lightTheme;

  return <ThemeCtx.Provider value={{ theme, isDark, themeMode, toggleTheme }}>{children}</ThemeCtx.Provider>;
}

export function useThemeCtx(): Ctx {
  return useContext(ThemeCtx);
}
