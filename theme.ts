import { useColorScheme } from 'react-native';

export const darkTheme = {
  bgBase: '#161513',
  bgSurface: '#201e1b',
  bgRaised: '#2a2724',
  border: '#333028',
  textPrimary: '#ede8e2',
  textMuted: '#908b85',
  accent: '#d4714e',
  accentSubtle: '#2d1c13',
  dark: true,
};

export const lightTheme = {
  bgBase: '#f7f4f0',
  bgSurface: '#edeae5',
  bgRaised: '#ffffff',
  border: '#dcd8d2',
  textPrimary: '#1c1a17',
  textMuted: '#6e6a64',
  accent: '#c5603f',
  accentSubtle: '#f4ece8',
  dark: false,
};

export type Theme = typeof darkTheme;

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'light' ? lightTheme : darkTheme;
}
