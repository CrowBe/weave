import type { Presentation, ProvenanceRole, ThemeRecord } from '@weave/tapestry';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

const PROVENANCE_ROLE = {
  operator: 'provenance-operator',
  runtime: 'provenance-runtime',
  host: 'provenance-host',
  clock: 'provenance-clock',
  judgment: 'provenance-judgment',
  untrusted: 'provenance-untrusted',
} as const satisfies Record<ProvenanceRole, keyof ThemeRecord['mark']>;

export function ConversationThread({
  presentation,
  theme,
}: {
  readonly presentation: Extract<Presentation, { kind: 'observations' } | { kind: 'omitted' }>;
  readonly theme: ThemeRecord;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="conversation-thread">
      <ScrollArea className="min-h-40 flex-1">
        {presentation.kind === 'omitted' ? (
          <p data-testid="observations-omitted" className="text-sm" style={{ color: 'var(--condition-omitted)' }}>
            <span className="mr-2 font-mono">{theme.mark['condition-omitted']}</span>
            {presentation.text}
          </p>
        ) : (
          <ol className="flex flex-col gap-2 pr-3">
            {presentation.items.map((item) => {
              const role = PROVENANCE_ROLE[item.provenance];
              const validationRole =
                item.validation.status === 'accepted'
                  ? 'validation-accepted'
                  : item.validation.status === 'rejected'
                    ? 'validation-rejected'
                    : 'validation-unknown';
              return (
                <li key={item.sequence} className="rounded-lg border bg-card px-3 py-2 text-sm" data-testid="observation">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {item.sequence}
                    </span>
                    <span className="font-mono text-xs">{item.type}</span>
                    <Badge variant="outline" style={{ color: `var(--${role})` }}>
                      {theme.mark[role]} {item.provenance}
                    </Badge>
                    <Badge variant="outline" style={{ color: `var(--${validationRole})` }}>
                      {theme.mark[validationRole]} {item.validation.status}
                      {item.validation.status === 'rejected' ? ` ${item.validation.reason}` : ''}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    cause {item.cause === null ? 'none' : String(item.cause)}
                  </p>
                </li>
              );
            })}
            {presentation.truncated ? (
              <li className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Earlier observations are truncated.
              </li>
            ) : null}
          </ol>
        )}
      </ScrollArea>
      <Separator />
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="text-xs" htmlFor="operator-input" style={{ color: 'var(--text-muted)' }}>
          Operator input
        </label>
        <textarea
          id="operator-input"
          data-testid="operator-input"
          disabled
          rows={2}
          placeholder="Unavailable"
          className="resize-none rounded-md border bg-background px-3 py-2 text-sm text-foreground"
        />
        <p data-testid="input-unavailable" className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Input is unavailable. operator.input has no trusted ingress contract.
        </p>
      </form>
    </div>
  );
}
