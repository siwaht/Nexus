import { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Appearance state: colour scheme, accent, font size and message density.
 *
 * Persisted to localStorage so the first paint is correct with no flash, and
 * mirrored to the server by the Appearance settings tab so preferences follow
 * the account across devices.
 */

export type Theme = 'light' | 'dark' | 'system';
export type Accent = 'default' | 'blue' | 'violet' | 'emerald' | 'amber' | 'rose';
export type FontSize = 'sm' | 'md' | 'lg';
export type Density = 'compact' | 'comfortable' | 'spacious';

export interface Appearance {
  theme: Theme;
  accent: Accent;
  fontSize: FontSize;
  density: Density;
}

interface ThemeContextValue extends Appearance {
  /** Resolved scheme after applying `system`. */
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  setAccent: (accent: Accent) => void;
  setFontSize: (size: FontSize) => void;
  setDensity: (density: Density) => void;
  setAppearance: (patch: Partial<Appearance>) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = 'nexus-appearance';

const ACCENT_HUES: Record<Accent, string | null> = {
  default: null,
  blue: '217 91% 60%',
  violet: '263 70% 62%',
  emerald: '160 62% 42%',
  amber: '38 92% 52%',
  rose: '347 77% 56%',
};

const FONT_SIZES: Record<FontSize, string> = {
  sm: '14px',
  md: '15px',
  lg: '17px',
};

const DENSITY_GAPS: Record<Density, string> = {
  compact: '0.75rem',
  comfortable: '1.25rem',
  spacious: '1.75rem',
};

function readStored(): Appearance {
  const fallback: Appearance = {
    theme: 'dark',
    accent: 'default',
    fontSize: 'md',
    density: 'comfortable',
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Migrate the Milestone-1 key so existing installs keep their choice.
      const legacy = localStorage.getItem('nexus-theme');
      if (legacy === 'light' || legacy === 'dark') {
        return { ...fallback, theme: legacy };
      }
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: (['light', 'dark', 'system'] as const).includes(parsed.theme as Theme)
        ? (parsed.theme as Theme)
        : fallback.theme,
      accent: parsed.accent && parsed.accent in ACCENT_HUES ? parsed.accent : 'default',
      fontSize:
        parsed.fontSize && parsed.fontSize in FONT_SIZES ? parsed.fontSize : 'md',
      density:
        parsed.density && parsed.density in DENSITY_GAPS
          ? parsed.density
          : 'comfortable',
    };
  } catch {
    return fallback;
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>(readStored);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    appearance.theme === 'system' ? (systemDark ? 'dark' : 'light') : appearance.theme;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(resolvedTheme);

    const hue = ACCENT_HUES[appearance.accent];
    if (hue) {
      root.style.setProperty('--primary', hue);
      root.style.setProperty('--ring', hue);
    } else {
      root.style.removeProperty('--primary');
      root.style.removeProperty('--ring');
    }

    root.style.setProperty('--nexus-font-size', FONT_SIZES[appearance.fontSize]);
    root.style.setProperty('--nexus-message-gap', DENSITY_GAPS[appearance.density]);
    root.dataset.density = appearance.density;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  }, [appearance, resolvedTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      ...appearance,
      resolvedTheme,
      setTheme: (theme) => setAppearanceState((current) => ({ ...current, theme })),
      setAccent: (accent) => setAppearanceState((current) => ({ ...current, accent })),
      setFontSize: (fontSize) =>
        setAppearanceState((current) => ({ ...current, fontSize })),
      setDensity: (density) =>
        setAppearanceState((current) => ({ ...current, density })),
      setAppearance: (patch) =>
        setAppearanceState((current) => ({ ...current, ...patch })),
    }),
    [appearance, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

export const ACCENT_OPTIONS = Object.keys(ACCENT_HUES) as Accent[];
export const FONT_SIZE_OPTIONS = Object.keys(FONT_SIZES) as FontSize[];
export const DENSITY_OPTIONS = Object.keys(DENSITY_GAPS) as Density[];
