import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { flattenTokens, governedContractFields, hashJson, type Approval, type DesignIR } from '@pwb/domain';
import { cacheKey, createRenderMatrix, REPRESENTATIVE_VIEWPORTS } from '@pwb/render-hub';
import { renderDesign } from '@pwb/renderer';

/** The hash the next stage consumes. It covers the identity contract only, so a page edit never reopens Gate 1. */
export function identityHash(ir: DesignIR): string { return hashJson(ir.identity); }

export interface IdentityGateRecord {
  runId: string;
  directionId: string;
  versionId: string;
  versionHash: string;
  identityHash: string;
  approverRole: 'captain';
  rationale: string;
  /** Why the captain approved over the blockers the gate listed, when they did. */
  overrideRationale?: string;
  approvedAt: string;
}

export interface IdentityChangeImpact {
  reopensGate: boolean;
  changedTokenPaths: string[];
  changedContractFields: string[];
  /**
   * Render cache entries the RenderHub wrote for the approved version, keyed on
   * the same preview route it is driven with. The cache is content-addressed, so
   * a token change makes these unreachable rather than stale; listing them is
   * what lets the studio drop them and lets a test prove no approved screenshot
   * survives a token change.
   */
  staleRenderKeys: string[];
}

function tokenValues(ir: DesignIR): Map<string, string> {
  return new Map([...flattenTokens(ir.identity.tokens)].map(([path, token]) => [path, JSON.stringify(token)]));
}

function contractFieldValue(ir: DesignIR, field: string): unknown {
  return field.split('.').reduce<unknown>((current, segment) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined), ir.identity);
}

export function identityChangeImpact(approved: DesignIR, current: DesignIR, approvedVersionId: string): IdentityChangeImpact {
  const before = tokenValues(approved);
  const after = tokenValues(current);
  const changedTokenPaths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
  const changedContractFields = governedContractFields
    .filter((field) => hashJson(contractFieldValue(approved, field)) !== hashJson(contractFieldValue(current, field)))
    .map((field) => String(field));
  const reopensGate = identityHash(approved) !== identityHash(current);
  if (!reopensGate) return { reopensGate, changedTokenPaths, changedContractFields, staleRenderKeys: [] };
  const approvedRender = renderDesign(approved, { routePrefix: `/preview/${approvedVersionId}` });
  const staleRenderKeys = createRenderMatrix(approved, { viewports: REPRESENTATIVE_VIEWPORTS }).map((renderCase) => cacheKey(approvedRender, renderCase));
  return { reopensGate, changedTokenPaths, changedContractFields, staleRenderKeys };
}

/**
 * Drops the RenderHub cache entries a change made unreachable. The cache is
 * content-addressed, so a stale entry can never be served by mistake; pruning
 * is about not keeping screenshots of an identity nobody approved. What comes
 * back is what the cache actually held, never the list of paths tried.
 */
export async function pruneRenderCache(cacheDir: string, keys: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const key of keys) {
    for (const extension of ['.evidence.json', '.evidence.png']) {
      const path = join(cacheDir, `${key}${extension}`);
      try { await rm(path); removed.push(path); } catch { /* the cache never held this entry */ }
    }
  }
  return removed;
}

/**
 * What the prototype stage receives. The next stage plans against
 * `versionId`, and `identityHash` is the contract it is allowed to read: if the
 * two stop agreeing, Gate 1 has reopened and the handoff is stale.
 */
export interface IdentityHandoff {
  directionId: string;
  versionId: string;
  identityHash: string;
  approvedAt: string;
  stale: boolean;
  /**
   * Imagery generated for the approved direction, each entry carrying its
   * prompt, model, licence and terms. The identity stage may not write
   * `/assets`, so these travel here for the stage that owns page media to place
   * in the ledger; nothing reaches an export without a licence on record.
   */
  assets: DesignIR['assets']['items'];
}

export function handoffOf(state: IdentityGateState, currentVersionId: string, assets: DesignIR['assets']['items'] = []): IdentityHandoff | undefined {
  if (state.state === 'open') return undefined;
  return { directionId: state.record.directionId, versionId: currentVersionId, identityHash: state.record.identityHash, approvedAt: state.record.approvedAt, stale: state.state === 'reopened', assets: structuredClone(assets) };
}

export type IdentityGateState =
  | { state: 'open'; reason: string }
  | { state: 'closed'; record: IdentityGateRecord }
  | { state: 'reopened'; record: IdentityGateRecord; impact: IdentityChangeImpact };

/**
 * Gate 1's state is derived, never stored twice. It reads the same approval
 * records the rest of the product already keeps and compares the approved
 * identity hash with the one in the document now, so a token change after the
 * gate reopens it without a second bookkeeping system to fall out of sync.
 */
export function evaluateIdentityGate(record: IdentityGateRecord | undefined, approvedIr: DesignIR | undefined, currentIr: DesignIR): IdentityGateState {
  if (!record || !approvedIr) return { state: 'open', reason: 'Gate 1 has not been decided by the captain yet.' };
  const impact = identityChangeImpact(approvedIr, currentIr, record.versionId);
  if (!impact.reopensGate) return { state: 'closed', record };
  return { state: 'reopened', record, impact };
}

/**
 * One row per decision, keyed on the decision's own place in the ledger the way
 * a rejection already is. What a decision landed on is a fact about the version,
 * not what tells two decisions apart.
 */
export function approvalOf(record: IdentityGateRecord, decisionIndex: number): Approval {
  return {
    id: `${record.runId}-identity-approval-${decisionIndex}`,
    stage: 'identity',
    approverRole: 'captain',
    versionId: record.versionId,
    versionHash: record.versionHash,
    decision: 'approved',
    rationale: record.overrideRationale ? `${record.rationale}\n\nOverride: ${record.overrideRationale}` : record.rationale,
    createdAt: record.approvedAt,
  };
}
