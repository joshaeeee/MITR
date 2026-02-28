import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import createContextHook from '@nkzw/create-context-hook';
import { LightColors, DarkColors, ColorScheme } from '@/constants/colors';

const THEME_KEY = 'mitr_dark_mode';

export const [ThemeProvider, useTheme] = createContextHook(() => {
  const [isDark, setIsDark] = useState<boolean>(false);
  const [loaded, setLoaded] = useState<boolean>(false);

  useEffect(() => {
    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(THEME_KEY);
        if (stored === 'true') {
          setIsDark(true);
        }
      } catch {
        console.log('Failed to load theme preference');
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const toggleDarkMode = useCallback(async () => {
    const next = !isDark;
    setIsDark(next);
    try {
      await AsyncStorage.setItem(THEME_KEY, String(next));
    } catch {
      console.log('Failed to save theme preference');
    }
  }, [isDark]);

  const colors: ColorScheme = isDark ? DarkColors : LightColors;

  return { isDark, toggleDarkMode, colors, loaded };
});

export function useColors(): ColorScheme {
  const { colors } = useTheme();
  return colors;
}
