import type { ReactNode } from 'react';
import type { DisclosedApproval, Presentation, ThemeRecord } from '@weave/tapestry';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Condition, Mark } from './mark';

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function chunks(value: string): readonly string[] {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 8) parts.push(value.slice(index, index + 8));
  return parts;
}

function Digest({ label, value }: { readonly label: string; readonly value: string }) {
  if (value.length <= 20) {
    return (
      <div>
        <div className="text-[12px] leading-4 font-medium" style={{ color: 'var(--text-muted)' }}>
          {label}
        </div>
        <div className="mt-1 font-mono text-[12px] leading-4 font-normal whitespace-nowrap text-[var(--text)]">{value}</div>
      </div>
    );
  }
  const preview = `${value.slice(0, 8)}…${value.slice(-8)}`;
  return (
    <details className="group">
      <summary className="grid grid-cols-[minmax(0,1fr)_auto] gap-y-0.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)]">
        <span className="text-[12px] leading-4 font-medium" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <span className="shrink-0 text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
          <span className="digest-closed">show</span>
          <span className="digest-open">hide</span>
        </span>
        <span className="digest-short col-span-2 font-mono text-[12px] leading-4 font-normal whitespace-nowrap text-[var(--text)] group-open:hidden">
          {preview}
        </span>
      </summary>
      <div className="digest-panel mt-1.5 rounded bg-[var(--canvas)] p-2 select-all" style={{ color: 'var(--text)' }}>
        <span className="block font-mono text-[11px] leading-5 font-normal" style={{ width: '36ch', maxWidth: '100%' }}>
          {chunks(value).map((part, index) => (
            <span key={index} className="digest-chunk inline-block">
              {part}
            </span>
          ))}
        </span>
      </div>
    </details>
  );
}

function Rows({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 px-[var(--pad)] py-3 pl-[calc(var(--pad)+8px)] xl:grid-cols-[8rem_minmax(0,1fr)] xl:px-4 xl:pl-5">
      {children}
    </div>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-[12px] leading-4 font-medium" style={{ color: 'var(--text-muted)' }}>
        {label}
      </dt>
      <dd className="min-w-0 text-[12px] leading-4">{children}</dd>
    </>
  );
}

const quietButton =
  'w-full border-dashed bg-transparent text-[var(--text-muted)] shadow-none disabled:opacity-100 disabled:border-dashed disabled:bg-transparent disabled:text-[var(--text-muted)]';

function ApprovalCard({ approval, theme }: { readonly approval: DisclosedApproval; readonly theme: ThemeRecord }) {
  const describedBy = `decision-unavailable-${approval.request_id}`;
  return (
    <Card
      data-testid="approval-pending"
      className="relative gap-0 overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--surface)] py-0 shadow-[var(--shadow-overlay)]"
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-[var(--decision-request)]" />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--hairline-soft)] px-[var(--pad)] py-3 pl-[calc(var(--pad)+8px)] xl:px-4 xl:pl-5">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Mark role="decision-request">{theme.mark['decision-request']}</Mark>
          <h3 className="text-[13px] leading-5 font-semibold">Pending authority request</h3>
        </div>
        <p className="ml-auto shrink-0 text-[12px] leading-4 whitespace-nowrap">
          <span style={{ color: 'var(--text-muted)' }}>sequence </span>
          <span className="font-mono font-normal text-[var(--text)] tabular-nums">{approval.sequence}</span>
        </p>
      </div>
      <CardContent className="px-0">
        <Rows>
          <Fact label="Operation">
            <span className="text-[13px] leading-5 font-semibold text-[var(--text)]">{approval.operation}</span>
          </Fact>
          <Fact label="Contract revision">
            <span className="font-mono font-normal text-[var(--text)]">{approval.contract_revision}</span>
          </Fact>
          <Fact label="Destination">
            <span className="font-mono font-normal text-[var(--text)]">{approval.destination}</span>
          </Fact>
          <Fact label="Effects">
            <ul className="flex flex-col gap-0.5">
              {approval.effects.map((effect, index) => (
                <li key={`${effect.mode}-${effect.resource}-${index}`}>
                  <span style={{ color: 'var(--text-muted)' }}>{effect.mode}</span>{' '}
                  <span className="font-mono font-normal text-[var(--text)]">{effect.resource}</span>
                </li>
              ))}
            </ul>
          </Fact>
          <Fact label="Expected revision">
            <span className="font-mono font-normal text-[var(--text)] tabular-nums">{approval.expected_revision}</span>
          </Fact>
        </Rows>
        <div className="border-t border-[var(--hairline-soft)]">
        <Rows>
          <Fact label="Reservation">
            <span className="text-[var(--text)]">
              <span className="whitespace-nowrap">{countLabel(approval.reservation.actions, 'action', 'actions')}</span>
              {' · '}
              <span className="whitespace-nowrap">{countLabel(approval.reservation.judgments, 'judgment', 'judgments')}</span>
            </span>
          </Fact>
          <Fact label="Valid ticks">
            <span className="font-mono font-normal whitespace-nowrap text-[var(--text)] tabular-nums">
              {approval.valid_from_tick}–{approval.valid_until_tick}
            </span>
          </Fact>
        </Rows>
        </div>
        <div className="flex flex-col gap-3 border-t border-[var(--hairline-soft)] px-[var(--pad)] py-3 pl-[calc(var(--pad)+8px)] xl:px-4 xl:pl-5">
          <Digest label="Binding digest" value={approval.binding_digest} />
          <Digest label="Report digest" value={approval.report_digest} />
        </div>
        <div className="border-t border-[var(--hairline-soft)] px-[var(--pad)] py-3 pl-[calc(var(--pad)+8px)] xl:px-4 xl:pl-5">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled
              data-testid="approve"
              aria-describedby={describedBy}
              className={quietButton}
            >
              <Mark role="muted">{theme.mark['decision-approve']}</Mark>
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled
              data-testid="deny"
              aria-describedby={describedBy}
              className={quietButton}
            >
              <Mark role="muted">{theme.mark['decision-deny']}</Mark>
              Deny
            </Button>
          </div>
          <p id={describedBy} data-testid="decision-unavailable" className="mt-2 text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
            Decision controls are unavailable. This component has no bound submission path.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function ApprovalPending({
  presentation,
  theme,
}: {
  readonly presentation: Extract<Presentation, { kind: 'approval' } | { kind: 'omitted' }>;
  readonly theme: ThemeRecord;
}) {
  if (presentation.kind === 'omitted') {
    return (
      <Condition
        kind="withheld"
        mark={theme.mark['condition-omitted']}
        text={presentation.text}
        testId="approvals-omitted"
      />
    );
  }
  return <ApprovalCard approval={presentation.approval} theme={theme} />;
}
