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
  return style;
}
