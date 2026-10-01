import type { Presentation, ThemeRecord } from '@weave/tapestry';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

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
      <p data-testid="availability-omitted" className="text-sm" style={{ color: 'var(--condition-omitted)' }}>
        <span className="mr-2 font-mono">{theme.mark['condition-omitted']}</span>
        {presentation.text}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1" data-testid="project-index">
      {presentation.items.map((item) => {
        const selected = presentation.selection === item.label;
        return (
          <li key={item.label}>
            <Button
              type="button"
              variant={selected ? 'secondary' : 'ghost'}
              className="h-auto w-full justify-start gap-2 px-2 py-1.5"
              aria-pressed={selected}
              data-selected={selected ? 'true' : 'false'}
              onClick={() => onSelect(item.label)}
            >
              <Badge variant="outline">{item.kind}</Badge>
              <span>{item.label}</span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
