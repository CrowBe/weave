# Trace ingestion port v1

The local trace boundary accepts a versioned JSONL tree envelope with fixed key
order: schema, id, parentId, run_id, kind, sequence, payload. Payloads are
closed safe scalar metrics and correlation references; no raw provider content,
operator text, environment values or errors cross this port. Unknown fields and
malformed envelopes fail closed. The composition root must supply a secret
redactor before serialization; serialization validates the redacted envelope.
An importer upserts by (run_id, id); repeated imports must be idempotent.

P9 supplies the schema and importer port only. SQLite adapter, normalization of
legacy records, and OTLP receiver are follow-ups before P10 comparisons.
