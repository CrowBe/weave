import type { ResourceRef } from "@weave/agentsop";
import { KindMismatch, UnknownResource } from "./errors.ts";

export interface ResourceRecord {
  ref: string;
  kind: string;
  label: string;
  locator: string;
  created_by: string;
}

export class ResourceRegistry {
  private readonly records = new Map<string, ResourceRecord>();
  private n = 0;

  issue(args: { kind: string; label: string; locator: string; created_by: string }): ResourceRecord {
    this.n += 1;
    const record: ResourceRecord = {
      ref: `rf_${this.n.toString(16)}`,
      kind: args.kind,
      label: args.label,
      locator: args.locator,
      created_by: args.created_by,
    };
    this.records.set(record.ref, record);
    return record;
  }

  get(ref: string): ResourceRecord | undefined {
    return this.records.get(ref);
  }

  require(ref: ResourceRef): ResourceRecord {
    const record = this.records.get(ref.ref);
    if (!record) throw new UnknownResource(`unknown resource ${ref.ref}`);
    if (record.kind !== ref.kind) {
      throw new KindMismatch(`resource ${ref.ref} is ${record.kind}, not ${ref.kind}`);
    }
    return record;
  }

  publicView(): Array<{ ref: string; kind: string; label: string }> {
    return [...this.records.values()].map((record) => ({
      ref: record.ref,
      kind: record.kind,
      label: record.label,
    }));
  }
}
