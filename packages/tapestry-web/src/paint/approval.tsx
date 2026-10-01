import type { DisclosedApproval, Presentation, ThemeRecord } from '@weave/tapestry';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function Field({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-xs">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </div>
  );
}

function ApprovalCard({ approval, theme }: { readonly approval: DisclosedApproval; readonly theme: ThemeRecord }) {
  const effects = approval.effects.map((effect) => `${effect.mode} ${effect.resource}`).join(', ');
  return (
    <Card data-testid="approval-pending" className="border-[color:var(--decision-request)]">
      <CardHeader>
        <CardTitle>
          <span className="mr-2 font-mono" style={{ color: 'var(--decision-request)' }}>
            {theme.mark['decision-request']}
          </span>
          Pending authority request
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-1">
          <Field label="operation" value={approval.operation} />
          <Field label="contract revision" value={approval.contract_revision} />
          <Field label="destination" value={approval.destination} />
          <Field label="effects" value={effects} />
          <Field label="expected revision" value={String(approval.expected_revision)} />
          <Field label="reservation" value={`${approval.reservation.actions} actions, ${approval.reservation.judgments} judgments`} />
          <Field label="valid ticks" value={`${approval.valid_from_tick}–${approval.valid_until_tick}`} />
          <Field label="binding digest" value={approval.binding_digest} />
          <Field label="report digest" value={approval.report_digest} />
          <Field label="sequence" value={String(approval.sequence)} />
        </dl>
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled data-testid="approve">
            {theme.mark['decision-approve']} Approve
          </Button>
          <Button type="button" variant="outline" size="sm" disabled data-testid="deny">
            {theme.mark['decision-deny']} Deny
          </Button>
        </div>
        <p data-testid="decision-unavailable" className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          Decision controls are unavailable. This component has no bound submission path.
        </p>
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
      <p data-testid="approvals-omitted" className="text-sm" style={{ color: 'var(--condition-omitted)' }}>
        <span className="mr-2 font-mono">{theme.mark['condition-omitted']}</span>
        {presentation.text}
      </p>
    );
  }
  return <ApprovalCard approval={presentation.approval} theme={theme} />;
}
