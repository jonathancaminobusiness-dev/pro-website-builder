import { hashJson, PatchSchema, type Patch } from '@pwb/domain';

function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }

export class PatchGate {
  private readonly accepted = new Map<string, { key: string; paths: string[] }[]>();

  validate(patch: Patch, context: { currentVersionId: string; allowedPaths: string[] }, options: { reserve?: boolean } = {}): { ok: true; duplicate: boolean; idempotencyKey: string } {
    const parsed = PatchSchema.parse(patch);
    if (parsed.baseVersionId !== context.currentVersionId) throw new Error(`Stale patch base ${parsed.baseVersionId}; current version is ${context.currentVersionId}.`);
    const key = parsed.idempotencyKey ?? hashJson([parsed.stage, parsed.role, parsed.baseVersionId, parsed.touchedPaths, parsed.rationale]);
    const records = this.accepted.get(parsed.baseVersionId) ?? [];
    const existing = records.find((record) => record.key === key);
    if (existing) { if (options.reserve !== false) throw new Error(`Idempotent patch ${key} was already accepted.`); return { ok: true, duplicate: true, idempotencyKey: key }; }
    for (const path of parsed.touchedPaths) {
      if (!context.allowedPaths.some((allowed) => overlaps(path, allowed))) throw new Error(`Patch path is not allowed: ${path}`);
      if (records.some((record) => record.paths.some((other) => overlaps(path, other)))) throw new Error(`Patch overlap at ${path}.`);
    }
    if (options.reserve !== false) this.accepted.set(parsed.baseVersionId, [...records, { key, paths: parsed.touchedPaths }]);
    return { ok: true, duplicate: false, idempotencyKey: key };
  }
}
