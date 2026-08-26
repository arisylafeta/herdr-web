import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const THEME_KEY = "herdr-web:theme";

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

function savedPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // Storage may be unavailable in private contexts.
  }
  return "system";
}

export function useTheme(): {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(savedPreference);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = resolveTheme(preference, query.matches);
      document.documentElement.dataset.theme = theme;
      document.querySelector('meta[name="theme-color"]')?.setAttribute(
        "content",
        theme === "dark" ? "#111212" : "#f7f8f6",
      );
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [preference]);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // The active session still changes theme when storage is unavailable.
    }
  };

  return { preference, setPreference };
}
