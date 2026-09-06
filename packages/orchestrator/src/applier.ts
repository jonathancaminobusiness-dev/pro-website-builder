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
function parentOf(root: unknown, path: string, action: string): { parent: any; last: string } { const parts = segments(path); const last = parts.pop(); if (last === undefined) throw new Error(`Cannot ${action} the document root.`); let current: any = root; for (const part of parts) current = current[part]; if (current === undefined || current === null) throw new Error(`Cannot ${action} ${path}; the parent does not exist.`); return { parent: current, last }; }
function setAt(root: unknown, path: string, value: unknown): void { const { parent, last } = parentOf(root, path, 'write'); parent[last] = value; }
function addAt(root: unknown, path: string, value: unknown): { array: boolean; last: string } { const { parent, last } = parentOf(root, path, 'write'); if (!Array.isArray(parent)) { parent[last] = value; return { array: false, last }; } const index = last === '-' ? parent.length : Number(last); if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error(`Cannot add at ${path}; the array index is out of range.`); parent.splice(index, 0, value); return { array: true, last: String(index) }; }
function removeAt(root: unknown, path: string): void { const { parent, last } = parentOf(root, path, 'remove'); if (!Array.isArray(parent)) { delete parent[last]; return; } const index = Number(last); if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error(`Cannot remove ${path}; the array index is out of range.`); parent.splice(index, 1); }
function siblingPath(path: string, last: string): string { return `${path.slice(0, path.lastIndexOf('/'))}/${last}`; }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

function applyOperations(base: DesignIR, patch: Patch): { next: DesignIR; inverse: Patch; diff: string[] } {
  const next = structuredClone(base);
  const inverseOps: Patch['operations'] = [];
  for (const operation of patch.operations) {
    const previous = structuredClone(getAt(next, operation.path));
    if (operation.op === 'test') { if (!equal(previous, operation.value)) throw new Error(`Patch test failed at ${operation.path}.`); continue; }
    if (operation.op === 'remove') { removeAt(next, operation.path); inverseOps.unshift({ op: 'add', path: operation.path, value: previous }); }
    else if (operation.op === 'add') {
      const target = addAt(next, operation.path, operation.value);
      if (target.array) inverseOps.unshift({ op: 'remove', path: siblingPath(operation.path, target.last) });
      else if (previous === undefined) inverseOps.unshift({ op: 'remove', path: operation.path });
      else inverseOps.unshift({ op: 'replace', path: operation.path, value: previous });
    }
    else { setAt(next, operation.path, operation.value); inverseOps.unshift({ op: 'replace', path: operation.path, value: previous }); }
  }
  const validated = DesignIRSchema.parse(next);
  return { next: validated, inverse: { ...patch, operations: inverseOps }, diff: patch.touchedPaths };
}

const ALLOWED_PATHS = ['/identity', '/tokens', '/pages', '/assets', '/reviewRecord'];

export interface DryRun { versionId: string; next: DesignIR; inverse: Patch; diff: string[]; }

export class Applier {
  constructor(private readonly store: VersionStore, private readonly gate: PatchGate) {}
  createRoot(ir: DesignIR): VersionRecord { const parsed = DesignIRSchema.parse(ir); const version: VersionRecord = { id: parsed.meta.versionId, hash: hashJson(parsed), ir: parsed, inverse: { op: 'proposal', operations: [], baseVersionId: parsed.meta.versionId, touchedPaths: [], rationale: 'Root version', confidence: 1, stage: 'identity', role: 'director' } }; this.store.save(version); return version; }
  dryRun(patch: Patch): DryRun { const current = this.store.get(patch.baseVersionId); if (!current) throw new Error(`Unknown base version ${patch.baseVersionId}.`); this.gate.validate(patch, { currentVersionId: current.id, allowedPaths: ALLOWED_PATHS }); const result = applyOperations(current.ir, patch); return { versionId: current.id, ...result }; }
  apply(patch: Patch): VersionRecord { const current = this.store.get(patch.baseVersionId); if (!current) throw new Error(`Unknown base version ${patch.baseVersionId}.`); const decision = this.gate.validate(patch, { currentVersionId: current.id, allowedPaths: ALLOWED_PATHS }); const result = applyOperations(current.ir, patch); const versionId = `v-${hashJson(result.next).slice(0, 12)}`; const ir = { ...result.next, meta: { ...result.next.meta, versionId } }; const next: VersionRecord = { id: versionId, hash: hashJson(ir), parentId: current.id, ir, inverse: result.inverse }; this.store.save(next); this.gate.commit(current.id, decision); return next; }
}
