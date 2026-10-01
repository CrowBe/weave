import type { Presentation, ProvenanceRole, StatusColorRole, ThemeRecord } from '@weave/tapestry';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Condition, Mark } from './mark';

const PROVENANCE_ROLE = {
  operator: 'provenance-operator',
  runtime: 'provenance-runtime',
  host: 'provenance-host',
  clock: 'provenance-clock',
  judgment: 'provenance-judgment',
  untrusted: 'provenance-untrusted',
} as const satisfies Record<ProvenanceRole, StatusColorRole>;

function validationRole(status: 'accepted' | 'rejected' | 'unknown'): StatusColorRole {
  if (status === 'accepted') return 'validation-accepted';
  if (status === 'rejected') return 'validation-rejected';
  return 'validation-unknown';
}

export function ConversationThread({
  presentation,
  theme,
}: {
  readonly presentation: Extract<Presentation, { kind: 'observations' } | { kind: 'omitted' }>;
  readonly theme: ThemeRecord;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="conversation-thread">
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-[var(--pad)] py-[var(--gap)]">
          {presentation.kind === 'omitted' ? (
            <Condition
              kind="withheld"
              mark={theme.mark['condition-omitted']}
              text={presentation.text}
              testId="observations-omitted"
            />
          ) : (
            <table className="w-full table-fixed border-separate border-spacing-0">
              <caption className="sr-only">Recorded observations</caption>
              <thead className="sticky top-0 bg-[var(--surface)]">
                <tr className="h-8 text-left text-[11px] leading-4 font-medium" style={{ color: 'var(--text-muted)' }}>
                  <th className="w-9 border-b border-[var(--hairline)] pr-2 text-right font-medium whitespace-nowrap">Seq</th>
                  <th className="border-b border-[var(--hairline)] px-2 font-medium whitespace-nowrap">Type</th>
                  <th className="w-[7.25rem] border-b border-[var(--hairline)] px-1.5 font-medium whitespace-nowrap">Provenance</th>
                  <th className="w-[7rem] border-b border-[var(--hairline)] px-1.5 font-medium whitespace-nowrap">Validation</th>
                  <th className="w-14 border-b border-[var(--hairline)] pl-1.5 font-medium whitespace-nowrap">Cause</th>
                </tr>
              </thead>
              <tbody>
                {presentation.truncated ? (
                  <tr>
                    <td colSpan={5} className="py-2 text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
                      Earlier observations are truncated.
                    </td>
                  </tr>
                ) : null}
                {presentation.items.map((item) => {
                  const provenance = PROVENANCE_ROLE[item.provenance];
                  const validation = validationRole(item.validation.status);
                  return (
                    <tr key={item.sequence} data-testid="observation">
                      <td className="h-[var(--row)] overflow-hidden border-b border-[var(--hairline-soft)] pr-2 text-right font-mono text-[12px] font-normal tabular-nums whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                        {item.sequence}
                      </td>
                      <td className="h-[var(--row)] overflow-hidden border-b border-[var(--hairline-soft)] px-2 font-mono text-[12px] font-normal text-[var(--text)] whitespace-nowrap" title={item.type}>
                        <span className="block truncate">{item.type}</span>
                      </td>
                      <td className="h-[var(--row)] overflow-hidden border-b border-[var(--hairline-soft)] px-1.5">
                        <span className="flex min-w-0 items-center gap-1 text-[12px]">
                          <Mark role={provenance}>{theme.mark[provenance]}</Mark>
                          <span className="truncate">{item.provenance}</span>
                        </span>
                      </td>
                      <td className="h-[var(--row)] overflow-hidden border-b border-[var(--hairline-soft)] px-1.5">
                        <span className="flex min-w-0 items-center gap-1 text-[12px]">
                          <Mark role={validation}>{theme.mark[validation]}</Mark>
                          <span className="truncate">{item.validation.status}</span>
                        </span>
                        {item.validation.status === 'rejected' ? (
                          <span className="mt-0.5 block text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
                            {item.validation.reason}
                          </span>
                        ) : null}
                      </td>
                      <td className="h-[var(--row)] overflow-hidden border-b border-[var(--hairline-soft)] pl-1.5 font-mono text-[12px] font-normal whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                        {item.cause === null ? 'none' : String(item.cause)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </ScrollArea>
      <form
        className="border-t border-[var(--hairline)] px-[var(--pad)] py-3"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="text-[12px] leading-4 font-medium" htmlFor="operator-input" style={{ color: 'var(--text-muted)' }}>
          Operator input
        </label>
        <textarea
          id="operator-input"
          data-testid="operator-input"
          disabled
          rows={2}
          placeholder="Unavailable"
          aria-describedby="input-unavailable"
          className="mt-2 w-full resize-none rounded-md border border-dashed border-[var(--hairline)] bg-[var(--canvas)] px-3 py-2 text-[13px] leading-5 text-[var(--text)] placeholder:text-[var(--text-muted)] disabled:cursor-not-allowed"
        />
        <p id="input-unavailable" data-testid="input-unavailable" className="mt-2 text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          Input is unavailable. <code className="font-mono text-[11px]">operator.input</code> has no trusted ingress contract.
        </p>
      </form>
    </div>
  );
}
