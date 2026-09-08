/**
 * A run id that is already taken. One definition, because both the fixture and
 * the identity routes reserve an id before they build the run behind it, and
 * both answer the same 409.
 */
export class RunConflictError extends Error {
  constructor(runId: string) { super(`Run ${runId} already exists.`); this.name = 'RunConflictError'; }
}
