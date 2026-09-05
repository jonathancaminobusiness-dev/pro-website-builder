import { hashJson, DesignIRSchema, type DesignIR, type Patch } from '@pwb/domain';
import { PatchGate } from './patch-gate.js';

export interface VersionRecord { id: string; hash: string; parentId?: string; ir: DesignIR; inverse: Patch; }

export class VersionStore {
  private readonly versions = new Map<string, VersionRecord>();
  save(version: VersionRecord): void { if (this.versions.has(version.id)) throw new Error(`Version ${version.id} already exists.`); this.versions.set(version.id, structuredClone(version)); }
  get(id: string): VersionRecord | undefined { const version = this.versions.get(id); return version ? structuredClone(version) : undefined; }
}

function segments(path: string): string[] { return path.split('/').slice(1).map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~')); }
function getAt(root: unknown, path: string): unknown { let current: any = root; for (const segment of segments(path)) current = current?.[segment]; return current; }
function setAt(root: unknown, path: string, value: unknown): void { const parts = segments(path); const last = parts.pop(); if (last === undefined) throw new Error('Cannot write the document root.'); let current: any = root; for (const part of parts) current = current[part]; current[last] = value; }
function removeAt(root: unknown, path: string): void { const parts = segments(path); const last = parts.pop(); if (last === undefined) throw new Error('Cannot remove the document root.'); let current: any = root; for (const part of parts) current = current[part]; if (Array.isArray(current)) current.splice(Number(last), 1); else delete current[last]; }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

function applyOperations(base: DesignIR, patch: Patch): { next: DesignIR; inverse: Patch; diff: string[] } {
  const next = structuredClone(base);
  const inverseOps: Patch['operations'] = [];
  for (const operation of patch.operations) {
    const previous = structuredClone(getAt(next, operation.path));
    if (operation.op === 'test') { if (!equal(previous, operation.value)) throw new Error(`Patch test failed at ${operation.path}.`); continue; }
    if (operation.op === 'remove') { removeAt(next, operation.path); inverseOps.unshift({ op: 'add', path: operation.path, value: previous }); }
    else if (operation.op === 'add') { setAt(next, operation.path, operation.value); inverseOps.unshift({ op: 'remove', path: operation.path }); }
    else { setAt(next, operation.path, operation.value); inverseOps.unshift({ op: 'replace', path: operation.path, value: previous }); }
  }
  const validated = DesignIRSchema.parse(next);
  return { next: validated, inverse: { ...patch, operations: inverseOps }, diff: patch.touchedPaths };
}

export interface DryRun { versionId: string; next: DesignIR; inverse: Patch; diff: string[]; }

export class Applier {
  constructor(private readonly store: VersionStore, private readonly gate: PatchGate) {}
  createRoot(ir: DesignIR): VersionRecord { const parsed = DesignIRSchema.parse(ir); const version: VersionRecord = { id: parsed.meta.versionId, hash: hashJson(parsed), ir: parsed, inverse: { op: 'proposal', operations: [], baseVersionId: parsed.meta.versionId, touchedPaths: [], rationale: 'Root version', confidence: 1, stage: 'identity', role: 'director' } }; this.store.save(version); return version; }
  dryRun(patch: Patch): DryRun { const current = this.store.get(patch.baseVersionId); if (!current) throw new Error(`Unknown base version ${patch.baseVersionId}.`); this.gate.validate(patch, { currentVersionId: current.id, allowedPaths: ['/identity', '/tokens', '/pages', '/assets', '/reviewRecord'] }, { reserve: false }); const result = applyOperations(current.ir, patch); return { versionId: current.id, ...result }; }
  apply(patch: Patch): VersionRecord { const current = this.store.get(patch.baseVersionId); if (!current) throw new Error(`Unknown base version ${patch.baseVersionId}.`); const validation = this.gate.validate(patch, { currentVersionId: current.id, allowedPaths: ['/identity', '/tokens', '/pages', '/assets', '/reviewRecord'] }); const result = applyOperations(current.ir, patch); const next: VersionRecord = { id: `v-${hashJson(result.next).slice(0, 12)}`, hash: hashJson(result.next), parentId: current.id, ir: { ...result.next, meta: { ...result.next.meta, versionId: `v-${hashJson(result.next).slice(0, 12)}` } }, inverse: result.inverse }; if (validation.duplicate) return current; this.store.save(next); return next; }
}
