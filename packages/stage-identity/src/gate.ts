import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { flattenTokens, governedContractFields, hashJson, type Approval, type DesignIR } from '@pwb/domain';
import { cacheKey, createRenderCases } from '@pwb/render-hub';
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
  approvedAt: string;
}

export interface IdentityChangeImpact {
  reopensGate: boolean;
  changedTokenPaths: string[];
  changedContractFields: string[];
  /**
   * Render cache entries produced from the approved identity. The RenderHub
   * keys its cache by the IR hash, so a token change makes these unreachable
   * rather than stale; listing them is what lets the studio drop them and lets a
   * test prove no approved screenshot survives a token change.
   */
  staleRenderKeys: string[];
}

function tokenValues(ir: DesignIR): Map<string, string> {
  return new Map([...flattenTokens(ir.identity.tokens)].map(([path, token]) => [path, JSON.stringify(token)]));
}

function contractFieldValue(ir: DesignIR, field: string): unknown {
  return field.split('.').reduce<unknown>((current, segment) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined), ir.identity);
}

export function identityChangeImpact(approved: DesignIR, current: DesignIR): IdentityChangeImpact {
  const before = tokenValues(approved);
  const after = tokenValues(current);
  const changedTokenPaths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
  const changedContractFields = governedContractFields
    .filter((field) => hashJson(contractFieldValue(approved, field)) !== hashJson(contractFieldValue(current, field)))
    .map((field) => String(field));
  const reopensGate = identityHash(approved) !== identityHash(current);
  const approvedRender = renderDesign(approved);
  const staleRenderKeys = reopensGate ? createRenderCases(approved).map((renderCase) => cacheKey(approvedRender, renderCase)) : [];
  return { reopensGate, changedTokenPaths, changedContractFields, staleRenderKeys };
}

/**
 * Drops the RenderHub cache entries a change made unreachable. The cache is
 * content-addressed, so a stale entry can never be served by mistake; pruning
 * is about not keeping screenshots of an identity nobody approved.
 */
export async function pruneRenderCache(cacheDir: string, keys: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const key of keys) {
    for (const extension of ['.json', '.png']) {
      const path = join(cacheDir, `${key}${extension}`);
      await rm(path, { force: true });
      removed.push(path);
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
  const impact = identityChangeImpact(approvedIr, currentIr);
  if (!impact.reopensGate) return { state: 'closed', record };
  return { state: 'reopened', record, impact };
}

export function approvalOf(record: IdentityGateRecord): Approval {
  return {
    id: `${record.runId}-identity-approval`,
    stage: 'identity',
    approverRole: 'captain',
    versionId: record.versionId,
    versionHash: record.versionHash,
    decision: 'approved',
    rationale: record.rationale,
    createdAt: record.approvedAt,
  };
}
