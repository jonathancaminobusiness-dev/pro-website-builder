import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { CONTROL_SEEDS, type ControlSeed } from '@pwb/stage-prototype';
import type { Gate2Snapshot, IssueDecision, PrototypeRunRegistry } from './prototype-api.js';

export interface PrototypeResponse { status: number; payload: unknown; }
type ReadBody = (request: IncomingMessage) => Promise<Record<string, unknown>>;

const decisions = new Set<IssueDecision>(['accepted', 'rejected', 'deferred']);

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

/**
 * The Gate 2 routes. Every state-changing call is captain-only, exactly like the phase 0 gates, and a
 * run only starts because the captain asked for it — no model work begins on its own.
 */
export async function handlePrototypeRequest(registry: PrototypeRunRegistry, request: IncomingMessage, pathname: string, readBody: ReadBody): Promise<PrototypeResponse | undefined> {
  if (request.method === 'POST' && pathname === '/api/prototype/runs') {
    const input = await readBody(request);
    const runId = text(input, 'runId') || `prototype-${randomUUID()}`;
    if (input.approverRole !== 'captain') return { status: 403, payload: { error: 'Only the captain can start a prototype run.' } };
    if (registry.has(runId)) return { status: 409, payload: { error: `Run ${runId} already exists.` } };
    const seed = (text(input, 'seed') || 'fixture') as ControlSeed;
    if (!CONTROL_SEEDS.includes(seed)) return { status: 400, payload: { error: `Unknown seed ${seed}; use ${CONTROL_SEEDS.join(' or ')}.` } };
    return { status: 201, payload: await registry.create(runId, seed) };
  }

  const match = /^\/api\/prototype\/runs\/([^/]+)(?:\/(decision|gate))?$/.exec(pathname);
  if (!match) return undefined;
  const runId = decodeURIComponent(match[1]!);
  const action = match[2];
  const existing: Gate2Snapshot | undefined = registry.get(runId);
  if (!existing) return { status: 404, payload: { error: 'Prototype run not found.' } };
  if (request.method === 'GET' && !action) return { status: 200, payload: existing };
  if (request.method !== 'POST') return { status: 405, payload: { error: 'Method not allowed.' } };

  const input = await readBody(request);
  if (input.approverRole !== 'captain') return { status: 403, payload: { error: 'Only the captain decides the prototype gate.' } };
  const rationale = text(input, 'rationale').trim();
  if (rationale === '') return { status: 400, payload: { error: 'A decision must carry a reason.' } };

  if (action === 'decision') {
    const decision = text(input, 'decision') as IssueDecision;
    if (!decisions.has(decision)) return { status: 400, payload: { error: 'A decision must be accepted, rejected or deferred.' } };
    const findingId = text(input, 'findingId');
    try { return { status: 200, payload: await registry.decide(runId, { findingId, decision, rationale }) }; }
    catch (error) { return { status: 400, payload: { error: error instanceof Error ? error.message : 'The decision was refused.' } }; }
  }

  if (action === 'gate') {
    const decision = text(input, 'decision');
    if (decision !== 'approved' && decision !== 'rejected') return { status: 400, payload: { error: 'A gate decision must be approved or rejected.' } };
    try { return { status: 200, payload: await registry.settle(runId, { decision, rationale }) }; }
    catch (error) { return { status: 409, payload: { error: error instanceof Error ? error.message : 'The gate decision was refused.' } }; }
  }

  return { status: 404, payload: { error: 'Not found.' } };
}
