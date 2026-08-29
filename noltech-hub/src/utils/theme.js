// ─── Theme Palette ────────────────────────────────────────────────────────────
// Hex values for use in JS contexts (Recharts, inline styles for SVG fills, etc.)
// For HTML/CSS, prefer Tailwind semantic classes (bg-accent, text-fg, etc.) or
// CSS custom properties (var(--accent)) which are theme-aware automatically.
//
// Values here match src/index.css :root tokens. When the theme changes we
// read these at runtime via readThemeToken().

export const PALETTE = {
  light: {
    bg:            '#F7F8FB',
    surface:       '#FFFFFF',
    elevated:      '#FFFFFF',
    muted:         '#F1F3F8',
    subtle:        '#F8FAFC',
    border:        '#E4E7EE',
    borderStrong:  '#CBD1DB',
    borderSubtle:  '#EEF0F5',
    fg:            '#0A0F1C',
    fgMuted:       '#5B6373',
    fgSubtle:      '#8A93A4',
    accent:        '#4F46E5',
    accentHover:   '#4338CA',
    success:       '#059669',
    danger:        '#DC2626',
    warning:       '#D97706',
    info:          '#0891B2',
  },
  dark: {
    bg:            '#06080F',
    surface:       '#0C1019',
    elevated:      '#121725',
    muted:         '#141A2A',
    subtle:        '#0F1421',
    border:        '#1F2736',
    borderStrong:  '#2F3A50',
    borderSubtle:  '#161C2A',
    fg:            '#F4F5F9',
    fgMuted:       '#A1A8BC',
    fgSubtle:      '#6B7389',
    accent:        '#6366F1',
    accentHover:   '#818CF8',
    success:       '#10B981',
    danger:        '#F87171',
    warning:       '#FBBF24',
    info:          '#22D3EE',
  },
};

// ─── Chart palette ─────────────────────────────────────────────────────────
// Used for multi-series charts (pie, stacked bars). Limited to well-contrasting
// hues that work in both themes.
export const CHART_COLORS = [
  '#6366F1',  // indigo (accent)
  '#10B981',  // emerald
  '#F59E0B',  // amber
  '#EC4899',  // pink
  '#06B6D4',  // cyan
  '#8B5CF6',  // violet
  '#F97316',  // orange
  '#14B8A6',  // teal
  '#EF4444',  // red
  '#84CC16',  // lime
  '#3B82F6',  // blue
  '#A855F7',  // purple
];

// Read current theme (light or dark)
export function isDarkMode() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('dark');
}

// Get the current palette for whatever theme is active
export function currentPalette() {
  return isDarkMode() ? PALETTE.dark : PALETTE.light;
}

// Read a token by name, respecting current theme
export function readThemeToken(name) {
  return currentPalette()[name];
}
