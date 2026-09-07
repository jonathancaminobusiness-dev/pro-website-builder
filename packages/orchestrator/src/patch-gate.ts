import { patchSchema, stagePatchSchemas, type Patch } from '@pwb/domain';

const unsafeSegments = new Set(['__proto__', 'constructor', 'prototype']);

function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function segmentsOf(path: string): string[] { return path.split('/').slice(1).map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~')); }

export interface GateDecision { ok: true; idempotencyKey: string; paths: string[]; }

export class PatchGate {
  private readonly accepted = new Map<string, { key: string; paths: string[] }[]>();

  validate(patch: Patch, context: { currentVersionId: string; allowedPaths: string[] }): GateDecision {
    const parsed = patchSchema.parse(patch);
    if (parsed.baseVersionId !== context.currentVersionId) throw new Error(`Stale patch base ${parsed.baseVersionId}; current version is ${context.currentVersionId}.`);
    const key = parsed.idempotencyKey;
    if (!key) throw new Error('Patch is missing the idempotency key its producer must derive from the task.');
    const records = this.accepted.get(parsed.baseVersionId) ?? [];
    if (records.some((record) => record.key === key)) throw new Error(`Idempotent patch ${key} was already accepted.`);
    const paths = [...new Set([...parsed.touchedPaths, ...parsed.operations.map((operation) => operation.path)])];
    for (const path of paths) {
      if (segmentsOf(path).some((segment) => unsafeSegments.has(segment))) throw new Error(`Patch path is not allowed: ${path}`);
      if (!context.allowedPaths.some((allowed) => overlaps(path, allowed))) throw new Error(`Patch path is not allowed: ${path}`);
      if (records.some((record) => record.paths.some((other) => overlaps(path, other)))) throw new Error(`Patch overlap at ${path}.`);
    }
    stagePatchSchemas[parsed.stage].parse(parsed);
    return { ok: true, idempotencyKey: key, paths };
  }

  commit(baseVersionId: string, decision: GateDecision): void {
    this.accepted.set(baseVersionId, [...(this.accepted.get(baseVersionId) ?? []), { key: decision.idempotencyKey, paths: decision.paths }]);
  }

  release(baseVersionId: string): void { this.accepted.delete(baseVersionId); }
}
