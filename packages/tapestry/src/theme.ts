import {
  COLOR_ROLES,
  DISTINCT_COLOR_PAIRS,
  STATUS_COLOR_ROLES,
  TOKEN_ROLES_ID,
  TYPE_ROLES,
  type ColorRole,
  type StatusColorRole,
  type TypeRole,
} from './tokens.js';

export interface ColorValue {
  readonly ansi: number | null;
  readonly srgb: string | null;
}

export interface TypeValue {
  readonly weight?: 'bold' | 'regular';
  readonly fixed_width?: boolean;
  readonly tabular?: boolean;
}

export interface ThemeRecord {
  readonly id: string;
  readonly version: 1;
  readonly roles: typeof TOKEN_ROLES_ID;
  readonly color: { readonly [Role in ColorRole]: ColorValue };
  readonly type: { readonly [Role in TypeRole]: TypeValue };
  readonly space: { readonly unit: number; readonly scale: readonly number[] };
  readonly density: {
    readonly comfort: 'comfortable' | 'compact';
    readonly list_rows: number;
    readonly gutter: number;
  };
  readonly elevation: { readonly base: number; readonly raised: number; readonly overlay: number };
  readonly mark: { readonly [Role in StatusColorRole]: string };
}

const TYPE: ThemeRecord['type'] = {
  title: { weight: 'bold' },
  heading: { weight: 'bold' },
  body: { weight: 'regular' },
  label: { weight: 'regular' },
  id: { fixed_width: true },
  numeric: { tabular: true },
};

const SPACE = { unit: 1, scale: [0, 1, 2, 3, 4, 6] } as const;
const ELEVATION = { base: 0, raised: 1, overlay: 2 } as const;

const MARKS: ThemeRecord['mark'] = {
  'provenance-operator': 'op',
  'provenance-runtime': 'rt',
  'provenance-host': 'ho',
  'provenance-clock': 'ck',
  'provenance-judgment': 'jd',
  'provenance-untrusted': '??',
  'eligibility-allowed': 'ok',
  'eligibility-approval': 'ap',
  'eligibility-prohibited': 'no',
  'action-pending': '..',
  'action-running': '>>',
  'action-succeeded': 'ok',
  'action-failed': 'x',
  'action-uncertain': '?',
  'action-cancelled': '--',
  'validation-accepted': 'yes',
  'validation-rejected': 'x',
  'validation-unknown': '?',
  'condition-empty': '[]',
  'condition-omitted': '-',
  'condition-stale': '~',
  'condition-exhausted': '!',
  'decision-request': '?',
  'decision-approve': 'yes',
  'decision-deny': 'no',
};

function color(srgb: string, ansi: number | null = null): ColorValue {
  return { ansi, srgb };
}

function theme(
  id: string,
  comfort: ThemeRecord['density']['comfort'],
  list_rows: number,
  gutter: number,
  values: { readonly [Role in ColorRole]: string },
): ThemeRecord {
  const record = {
    id,
    version: 1 as const,
    roles: TOKEN_ROLES_ID,
    color: Object.fromEntries(COLOR_ROLES.map((role) => [role, color(values[role])])) as ThemeRecord['color'],
    type: TYPE,
    space: SPACE,
    density: { comfort, list_rows, gutter },
    elevation: ELEVATION,
    mark: MARKS,
  };
  assertTheme(record);
  return record;
}

export function assertTheme(record: ThemeRecord): void {
  for (const role of COLOR_ROLES) {
    if (!record.color[role] || record.color[role].srgb === null) {
      throw new Error(`theme ${record.id} omits color role ${role}`);
    }
  }
  for (const role of STATUS_COLOR_ROLES) {
    if (!record.mark[role]) {
      throw new Error(`theme ${record.id} omits mark for ${role}`);
    }
  }
  for (const role of TYPE_ROLES) {
    if (!record.type[role]) {
      throw new Error(`theme ${record.id} omits type role ${role}`);
    }
  }
  for (const [left, right] of DISTINCT_COLOR_PAIRS) {
    if (record.color[left].srgb === record.color[right].srgb) {
      throw new Error(`theme ${record.id} gives one value to ${left} and ${right}`);
    }
  }
}

const DARK = {
  canvas: '#14181c',
  surface: '#1c2228',
  'surface-raised': '#262e36',
  border: '#3a4550',
  text: '#e7ecef',
  'text-muted': '#9aa6b2',
  focus: '#7eb6ff',
  'provenance-operator': '#c4b5fd',
  'provenance-runtime': '#93c5fd',
  'provenance-host': '#86efac',
  'provenance-clock': '#fcd34d',
  'provenance-judgment': '#f9a8d4',
  'provenance-untrusted': '#fda4af',
  'eligibility-allowed': '#86efac',
  'eligibility-approval': '#fcd34d',
  'eligibility-prohibited': '#fda4af',
  'action-pending': '#fcd34d',
  'action-running': '#93c5fd',
  'action-succeeded': '#86efac',
  'action-failed': '#f87171',
  'action-uncertain': '#c4b5fd',
  'action-cancelled': '#9aa6b2',
  'validation-accepted': '#4ade80',
  'validation-rejected': '#fb7185',
  'validation-unknown': '#fcd34d',
  'condition-empty': '#9aa6b2',
  'condition-omitted': '#fbbf24',
  'condition-stale': '#fdba74',
  'condition-exhausted': '#f87171',
  'decision-request': '#fcd34d',
  'decision-approve': '#4ade80',
  'decision-deny': '#fb7185',
} as const satisfies { readonly [Role in ColorRole]: string };

const DAYLIGHT = {
  canvas: '#f4f1ea',
  surface: '#fffdf8',
  'surface-raised': '#e7e1d6',
  border: '#c9c1b4',
  text: '#1c1917',
  'text-muted': '#57534e',
  focus: '#1d4ed8',
  'provenance-operator': '#6d28d9',
  'provenance-runtime': '#1d4ed8',
  'provenance-host': '#047857',
  'provenance-clock': '#b45309',
  'provenance-judgment': '#be185d',
  'provenance-untrusted': '#be123c',
  'eligibility-allowed': '#047857',
  'eligibility-approval': '#b45309',
  'eligibility-prohibited': '#be123c',
  'action-pending': '#b45309',
  'action-running': '#1d4ed8',
  'action-succeeded': '#047857',
  'action-failed': '#b91c1c',
  'action-uncertain': '#6d28d9',
  'action-cancelled': '#57534e',
  'validation-accepted': '#047857',
  'validation-rejected': '#be123c',
  'validation-unknown': '#b45309',
  'condition-empty': '#57534e',
  'condition-omitted': '#a16207',
  'condition-stale': '#c2410c',
  'condition-exhausted': '#b91c1c',
  'decision-request': '#b45309',
  'decision-approve': '#047857',
  'decision-deny': '#be123c',
} as const satisfies { readonly [Role in ColorRole]: string };

export const THEME_DEFAULT = theme('theme.weave-default', 'comfortable', 12, 2, DARK);
export const THEME_DAYLIGHT = theme('theme.weave-daylight', 'compact', 16, 1, DAYLIGHT);

const THEMES = [THEME_DEFAULT, THEME_DAYLIGHT];

export function themeById(id: string): ThemeRecord | undefined {
  return THEMES.find((record) => record.id === id);
}
