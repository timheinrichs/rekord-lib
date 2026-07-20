/** rekord-lib — design tokens as a TS object.
 *  Useful outside of Tailwind, e.g. for canvas waveform rendering,
 *  chart colors or Tauri window theming.
 */
export const accent = {
  50: '#EEEDFC', 100: '#DAD7F8', 200: '#BCB6F1', 300: '#9C93E9',
  400: '#8177E0', 500: '#6A5FD6', 600: '#574BC0', 700: '#473C9E',
  800: '#3A327E', 900: '#282160', 950: '#191340',
} as const;

export const graphite = {
  0: '#FFFFFF', 50: '#F6F6F8', 100: '#ECECEF', 200: '#D9D9DF',
  300: '#B7B7C0', 400: '#8C8C98', 500: '#666671', 600: '#4A4A55',
  700: '#343440', 750: '#292933', 800: '#201F28', 850: '#17161D',
  900: '#100F14', 950: '#09090C',
} as const;

export const status = {
  success: '#22B27A',  // compatible / ready
  warning: '#F5A623',  // conversion needed / FLAC note
  danger:  '#E5484D',  // incompatible / E-8305 risk
  info:    '#3B82F6',
} as const;

/** Theme-dependent, semantic colors. */
export const theme = {
  dark: {
    bg: '#100F14', surface: '#17161D', surface2: '#201F28',
    border: '#292933', borderStrong: '#343440',
    fg: '#F6F6F8', fgMuted: '#B7B7C0', fgSubtle: '#8C8C98',
  },
  light: {
    bg: '#F6F6F8', surface: '#FFFFFF', surface2: '#ECECEF',
    border: '#D9D9DF', borderStrong: '#B7B7C0',
    fg: '#100F14', fgMuted: '#4A4A55', fgSubtle: '#666671',
  },
} as const;

export const radius = { sm: 4, md: 8, lg: 12, xl: 16, xl2: 20 } as const;

export const font = {
  sans: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", "Menlo", monospace',
} as const;
