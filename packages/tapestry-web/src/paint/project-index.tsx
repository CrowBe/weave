import type { Presentation, ThemeRecord } from '@weave/tapestry';
import { Condition } from './mark';

export function ProjectIndex({
  presentation,
  theme,
  onSelect,
}: {
  readonly presentation: Extract<Presentation, { kind: 'index' } | { kind: 'omitted' }>;
  readonly theme: ThemeRecord;
  readonly onSelect: (label: string) => void;
}) {
  if (presentation.kind === 'omitted') {
    return (
      <Condition kind="withheld" mark={theme.mark['condition-omitted']} text={presentation.text} testId="availability-omitted" />
    );
  }
  return (
    <div data-testid="project-index">
      <div className="mb-1 flex items-baseline justify-between px-2 text-[12px] leading-4 font-medium" style={{ color: 'var(--text-muted)' }}>
        <span>Attachments</span>
        <span className="tabular-nums">{presentation.items.length}</span>
      </div>
      <ul className="flex flex-col">
        {presentation.items.map((item) => {
          const selected = presentation.selection === item.label;
          return (
            <li key={item.label}>
              <button
                type="button"
                aria-pressed={selected}
                data-selected={selected ? 'true' : 'false'}
                onClick={() => onSelect(item.label)}
                className="relative flex h-[var(--row)] w-full items-center gap-2 rounded-md px-2 text-left text-[13px] leading-5 font-normal hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] aria-pressed:font-medium data-[selected=true]:bg-[var(--surface-raised)]"
              >
                {selected ? <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--focus)]" /> : null}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {item.kind}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
