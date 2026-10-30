# Recurring judgment findings (#203, first slice)

`recurring-findings.ts` records capability gaps for check capabilities. Its
inputs are observations, never authority to generate, admit or execute a check.

- `recurrenceKey` hashes the versioned tuple of finding kind, criterion id
  (including null) and check-relevant evidence reference. Execution ids and
  proposed fixes are excluded. Unsafe identifiers, incompatible site/kind pairs
  and evidence naming its own execution id have no recurrence key. The id names
  the execution only when it occupies whole segments of the reference, bounded
  by its ends or `_ . : -`; `exec-1` inside `ref_exec-10` does not.
- The caller must supply an evidence reference stable across executions and
  specific to the property a check could enforce. A resource reference alone
  cannot distinguish two different defects on that resource. The repository
  cannot establish this semantic equivalence from opaque references.
- Audit findings count only with a `fix_now` disposition. D5 findings count only
  when `passed` is false, both statistics are finite numbers in `[0, 1]`,
  confidence is at least 0.9 and verdict probability is below 0.8. Missing,
  malformed and low-confidence answers are not judgment-caught failures.
- The recurrence policy is declared before reading findings. The default is
  **two distinct executions**; callers may declare an integer from 2 to 100.
  Repeated rounds or retries inside one execution count once. One record per
  recurring key cites all distinct executions in sorted order; keys below the
  threshold produce no record. Gap identities and output order are stable.
- A gap names a desired `check.*` operation, not an executable contract. An
  operator may open a goal with its `desired` value as the goal's `gap`. The
  ordinary gap search, contract, corpus, red, green, admission and execution
  authority gates still apply. Recording alone invokes none of them.

`checkCoverage` is a reporting hook: distinct findings per execution are the
denominator. A finding is in the numerator when a gap records its recurrence key
and the check operation derived from that key is a caller-supplied admitted
operation. A gap's `desired.operation` is not trusted, so a gap whose operation
was changed cannot cover another key's findings. A gap alone covers nothing; an empty denominator
returns a null share. This is coverage at report time, not proof that the check
ran, caught the failure, or was admitted after it. The caller must obtain
admitted operations from trusted admission records. Gauge's contracts (#189)
and producers (#193) are present; binding this hook to a governed Gauge result
and recording admission chronology are outside this record-only slice.

The executable fixture is `../test/recurring-findings.test.ts`: the same finding
in two executions produces one gap, a different finding produces none, and an
operator goal using the record stops at an unmet crystallization gate without
generating or admitting an implementation.
