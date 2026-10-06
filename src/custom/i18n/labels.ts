/**
 * Localized labels for core enums that upstream renders raw (fork,
 * P-004): colour mode and accent theme names. English values are
 * upstream's own text, so English deploys render exactly as before.
 */
import { getT } from '@/lib/i18n/translate';

const tTheme = getT('Custom.theme');

/** `light` / `dark` → "claro" / "escuro" (lowercase; capitalize at the call site). */
export function modeLabel(mode: string): string {
  return mode === 'light' || mode === 'dark' ? tTheme(`modes.${mode}`) : mode;
}

const THEME_IDS = ['violet', 'emerald', 'cobalt', 'amber', 'rose'];

export function themeName(id: string, fallback: string): string {
  return THEME_IDS.includes(id) ? tTheme(`names.${id}`) : fallback;
}

export function themeTagline(id: string, fallback: string): string {
  return THEME_IDS.includes(id) ? tTheme(`taglines.${id}`) : fallback;
}
