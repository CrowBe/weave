import type { StatusColorRole } from '@weave/tapestry';

export function Mark({ role, children }: { readonly role: StatusColorRole | 'muted'; readonly children: string }) {
  const tone = role === 'muted' ? 'var(--text-muted)' : `var(--${role})`;
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-[18px] min-w-[22px] items-center justify-center rounded px-1 font-mono text-[10.5px] leading-none font-medium"
      style={{
        color: tone,
        background: `color-mix(in oklab, ${tone} 14%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone} 28%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

export function Condition({
  kind,
  mark,
  text,
  testId,
}: {
  readonly kind: 'withheld' | 'empty';
  readonly mark: string;
  readonly text: string;
  readonly testId?: string;
}) {
  if (kind === 'withheld') {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2.5"
        style={{ borderColor: 'color-mix(in oklab, var(--condition-omitted) 45%, transparent)' }}
      >
        <Mark role="condition-omitted">{mark}</Mark>
        <span data-testid={testId} className="text-[13px] leading-5" style={{ color: 'var(--condition-omitted)' }}>
          {text}
        </span>
      </div>
    );
  }
  return (
    <p className="flex items-center gap-2 text-[13px] leading-5" style={{ color: 'var(--text-muted)' }}>
      <Mark role="condition-empty">{mark}</Mark>
      <span>{text}</span>
    </p>
  );
}
