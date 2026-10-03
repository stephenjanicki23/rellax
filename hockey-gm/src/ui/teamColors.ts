import type { CSSProperties } from 'react';

const luminance = (hex: string): number => {
  const n = parseInt(hex.replace('#', ''), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};

/**
 * Menu accent variables for a team on the dark console theme. `--m-team` is
 * the underline/bar colour (primary unless it is near-black), `--m-team2` is
 * text-safe (whichever team colour reads best on dark).
 */
export function teamAccentVars(colors: [string, string]): CSSProperties {
  const [a, b] = colors;
  const bar = luminance(a) < 0.02 ? b : a;
  const text = luminance(a) >= luminance(b) ? a : b;
  return { '--m-team': bar, '--m-team2': luminance(text) < 0.05 ? '#dfe3e8' : text } as CSSProperties;
}
