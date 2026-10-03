import { COLOR_ROLES, type ColorRole, type ThemeRecord } from '@weave/tapestry';

/**
 * shadcn semantic names bound to Tapestry token roles. The web package owns
 * this map. The presentation core does not.
 */
export const SHADCN_ROLE: Record<string, ColorRole> = {
  background: 'canvas',
  foreground: 'text',
  card: 'surface',
  'card-foreground': 'text',
  primary: 'text',
  'primary-foreground': 'canvas',
  secondary: 'surface-raised',
  'secondary-foreground': 'text',
  muted: 'surface-raised',
  'muted-foreground': 'text-muted',
  accent: 'surface-raised',
  'accent-foreground': 'text',
  border: 'border',
  input: 'border',
  ring: 'focus',
  destructive: 'decision-deny',
};

function spacePx(theme: ThemeRecord, index: number): string {
  const step = theme.space.scale[index] ?? 0;
  return `${step * theme.space.unit * 4}px`;
}

/** Relative luminance of a #rrggbb canvas. Below 0.2 is the dark scheme. */
export function canvasIsDark(srgb: string): boolean {
  const hex = srgb.replace('#', '');
  if (hex.length !== 6) return true;
  const channel = (start: number) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance < 0.2;
}

export function themeProperties(theme: ThemeRecord): Record<string, string> {
  const style: Record<string, string> = {};
  for (const role of COLOR_ROLES) {
    const srgb = theme.color[role].srgb;
    if (srgb !== null) style[`--${role}`] = srgb;
  }
  for (const [alias, role] of Object.entries(SHADCN_ROLE)) {
    const srgb = theme.color[role].srgb;
    if (srgb !== null) style[`--${alias}`] = srgb;
  }
  const pixel = 4;
  for (const [index, step] of theme.space.scale.entries()) {
    style[`--space-${index}`] = `${step * theme.space.unit * pixel}px`;
  }
  const compact = theme.density.comfort === 'compact';
  style['--pad'] = spacePx(theme, theme.density.gutter + 2);
  style['--gap'] = spacePx(theme, theme.density.gutter + 1);
  style['--row'] = compact ? '28px' : '36px';
  style['--bar'] = compact ? '36px' : '40px';
  const canvas = theme.color.canvas.srgb ?? '#14181c';
  const dark = canvasIsDark(canvas);
  style.colorScheme = dark ? 'dark' : 'light';
  style['--shadow-overlay'] = dark
    ? '0 1px 2px rgb(0 0 0 / 0.4), 0 12px 32px -12px rgb(0 0 0 / 0.55)'
    : '0 1px 2px rgb(28 25 23 / 0.06), 0 12px 32px -16px rgb(28 25 23 / 0.18)';
  return style;
}
