export interface OrchestratorEvent { id: string; type: string; runId: string; createdAt: string; payload: Record<string, unknown>; }

export class EventLog {
  private readonly entries: OrchestratorEvent[] = [];
  append(event: OrchestratorEvent): void { this.entries.push(structuredClone(event)); }
  list(): OrchestratorEvent[] { return structuredClone(this.entries); }
}
