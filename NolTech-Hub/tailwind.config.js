/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans:    ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        // ─── Semantic tokens (theme-aware via CSS vars) ──────────────────────
        // Use these in app code. Legacy aliases below map to these.

        // Backgrounds
        bg:         'var(--bg)',
        surface:    'var(--surface)',
        elevated:   'var(--elevated)',
        recessed:   'var(--recessed)',
        muted:      'var(--muted)',
        subtle:     'var(--subtle)',

        // Borders
        border:     'var(--border)',
        'border-strong': 'var(--border-strong)',
        'border-subtle': 'var(--border-subtle)',
        'border-active': 'var(--border-active)',

        // Text
        fg:          'var(--fg)',
        'fg-muted':  'var(--fg-muted)',
        'fg-subtle': 'var(--fg-subtle)',
        'fg-onAccent':'var(--fg-onAccent)',

        // Intent colors
        accent: {
          DEFAULT: 'var(--accent)',
          hover:   'var(--accent-hover)',
          subtle:  'var(--accent-subtle)',
          fg:      'var(--accent-fg)',
          ring:    'var(--accent-ring)',
        },
        success: {
          DEFAULT: 'var(--success)',
          subtle:  'var(--success-subtle)',
          fg:      'var(--success-fg)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          subtle:  'var(--danger-subtle)',
          fg:      'var(--danger-fg)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          subtle:  'var(--warning-subtle)',
          fg:      'var(--warning-fg)',
        },
        info: {
          DEFAULT: 'var(--info)',
          subtle:  'var(--info-subtle)',
          fg:      'var(--info-fg)',
        },

        // ─── Legacy aliases (keep during migration) ──────────────────────────
        nolbg:         'var(--bg)',
        textprimary:   'var(--fg)',
        textsecondary: 'var(--fg-muted)',
        primary: {
          DEFAULT: 'var(--accent)',
          light:   'var(--accent-hover)',
          dark:    'var(--accent)',
        },
        secondary: {
          DEFAULT: 'var(--accent-hover)',
          light:   'var(--accent-hover)',
          dark:    'var(--accent)',
        },
        brand: {
          DEFAULT: 'var(--accent)',
          light:   'var(--accent-hover)',
          dark:    'var(--accent)',
          50:      'var(--accent-subtle)',
          100:     'var(--accent-subtle)',
        },
        ll: {
          bg:      'var(--bg)',
          surface: 'var(--surface)',
          border:  'var(--border)',
          text:    'var(--fg)',
          muted:   'var(--fg-muted)',
          faint:   'var(--fg-subtle)',
        },
      },
      boxShadow: {
        // Multi-layer glossy shadows
        'glow-sm':       '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        'glow':          '0 1px 3px 0 rgb(15 23 42 / 0.05), 0 4px 12px -2px rgb(15 23 42 / 0.08)',
        'glow-md':       '0 2px 4px -1px rgb(15 23 42 / 0.06), 0 8px 20px -4px rgb(15 23 42 / 0.1)',
        'glow-lg':       '0 4px 8px -2px rgb(15 23 42 / 0.08), 0 16px 40px -8px rgb(15 23 42 / 0.14)',
        'glow-xl':       '0 8px 16px -4px rgb(15 23 42 / 0.1), 0 24px 64px -12px rgb(15 23 42 / 0.18)',
        'accent-glow':   '0 4px 16px -2px rgb(99 102 241 / 0.35), 0 0 0 1px rgb(99 102 241 / 0.12) inset',
        'accent-glow-lg':'0 8px 32px -4px rgb(99 102 241 / 0.45), 0 0 0 1px rgb(99 102 241 / 0.2) inset',
        'inner-top':     'inset 0 1px 0 0 rgb(255 255 255 / 0.08)',
        // Legacy
        card:            '0 1px 3px 0 rgb(15 23 42 / 0.05), 0 4px 12px -2px rgb(15 23 42 / 0.06)',
        'card-md':       '0 2px 4px -1px rgb(15 23 42 / 0.06), 0 8px 20px -4px rgb(15 23 42 / 0.08)',
      },
      backgroundImage: {
        'surface-gradient':  'var(--surface-gradient)',
        'elevated-gradient': 'var(--elevated-gradient)',
        'accent-gradient':   'var(--accent-gradient)',
        'success-gradient':  'var(--success-gradient)',
        'danger-gradient':   'var(--danger-gradient)',
        'hero-gradient':     'var(--hero-gradient)',
        'brand-gradient':    'var(--brand-gradient)',
        'brand-gradient-soft':'var(--brand-gradient-soft)',
      },
      // ─── Letter-spacing scale per design spec ─────────────────────────
      // Tracking tightens as size increases (display-feel) — Tailwind's
      // tracking-* utilities give us named anchors; the index.css h-display-*
      // utilities use these values directly.
      letterSpacing: {
        'extra-tight': '-0.030em',
        'super-tight': '-0.025em',
        'display':     '-0.022em',
        'heading':     '-0.019em',
        'subheading':  '-0.014em',
        'body':        '-0.011em',
        'caption':     '-0.006em',
        'eyebrow':     '0.10em',
      },
      borderRadius: {
        '4xl': '2rem',
      },
      transitionTimingFunction: {
        'out-expo':    'cubic-bezier(0.16, 1, 0.3, 1)',
        'in-out-expo': 'cubic-bezier(0.87, 0, 0.13, 1)',
      },
      animation: {
        'fade-in':    'fadeIn 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up':   'slideUp 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-down': 'slideDown 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in':   'scaleIn 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        'shimmer':    'shimmer 1.8s linear infinite',
      },
      keyframes: {
        fadeIn:    { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        slideUp:   { '0%': { opacity: 0, transform: 'translateY(8px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
        slideDown: { '0%': { opacity: 0, transform: 'translateY(-8px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
        scaleIn:   { '0%': { opacity: 0, transform: 'scale(0.96)' }, '100%': { opacity: 1, transform: 'scale(1)' } },
        shimmer:   { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
      },
    },
  },
  plugins: [],
};
