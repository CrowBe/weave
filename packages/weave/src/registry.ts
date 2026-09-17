import type {
  AdmissionVerdict,
  CapabilityContract,
  ImplementationCandidate,
} from "@weave/agentfabric";

export interface AdmittedCapability {
  contract: CapabilityContract;
  implementation: ImplementationCandidate;
  maturity: string;
  admission: AdmissionVerdict;
  admittedAt: string;
}

export class CapabilityRegistry {
  private readonly records = new Map<string, AdmittedCapability>();

  get(id: string): AdmittedCapability | undefined {
    return this.records.get(id);
  }

  list(): AdmittedCapability[] {
    return [...this.records.values()];
  }

  admit(record: AdmittedCapability): void {
    if (!record.admission.eligible) {
      throw new Error("cannot admit a capability that is not eligible");
    }
    this.records.set(record.contract.id, record);
  }

  revoke(id: string): void {
    this.records.delete(id);
  }
}
