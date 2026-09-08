import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tokenValueSchema } from '@pwb/domain';
import { StageError } from '@pwb/stage-identity';
import { RunConflictError } from './run-conflict.js';
import type { IdentityRun, IdentityRunSnapshot } from './identity-run.js';

export interface IdentityApiOptions {
  runs: Map<string, IdentityRun>;
  createRun: (id: string) => Promise<IdentityRun>;
  /** Rebuilds a run this process never held, so a restart does not lose an open Gate 1. */
  loadRun?: (id: string) => Promise<IdentityRun | undefined>;
}

async function resolve(options: IdentityApiOptions, runId: string): Promise<IdentityRun | undefined> {
  return options.runs.get(runId) ?? (options.loadRun ? await options.loadRun(runId) : undefined);
}

type Send = (status: number, body: unknown) => void;
type ReadBody = (request: IncomingMessage) => Promise<Record<string, unknown>>;

function captain(input: Record<string, unknown>, send: Send, action: string): boolean {
  if (input.approverRole === 'captain') return true;
  send(403, { error: `Only the captain can ${action} Gate 1 in v1.` });
  return false;
}

/**
 * The Gate 1 routes. Creating a run costs nothing; `start` is the only route
 * that spends a model turn, and it exists so that no worker ever runs without
 * the captain asking for it.
 *
 * Returns true when it handled the request, so the main API can delegate with
 * one additive line.
 */
export async function handleIdentityRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: IdentityApiOptions,
  helpers: { send: Send; body: ReadBody },
): Promise<boolean> {
  const { send, body } = helpers;
  if (!pathname.startsWith('/api/identity')) return false;

  if (request.method === 'POST' && pathname === '/api/identity/runs') {
    const input = await body(request);
    const runId = typeof input.runId === 'string' ? input.runId : `identity-${randomUUID()}`;
    // A run that is only on disk exists just as much as one this process holds:
    // creating over it would hand the captain an empty run under a decided id.
    if (options.runs.has(runId) || await resolve(options, runId)) { send(409, { error: `Run ${runId} already exists.` }); return true; }
    let created: IdentityRun;
    try { created = await options.createRun(runId); }
    catch (error) { if (error instanceof RunConflictError) { send(409, { error: error.message }); return true; } throw error; }
    send(201, created.snapshot());
    return true;
  }

  const match = /^\/api\/identity\/runs\/([^/]+)(?:\/(start|approve|reject|cancel|token))?$/.exec(pathname);
  if (!match) { send(404, { error: 'Not found.' }); return true; }
  const run = await resolve(options, decodeURIComponent(match[1]!));
  if (!run) { send(404, { error: 'Identity run not found.' }); return true; }
  const action = match[2];

  if (request.method === 'GET' && !action) { send(200, run.snapshot()); return true; }
  if (request.method !== 'POST') { send(405, { error: 'Method not allowed.' }); return true; }

  const input = await body(request);
  let snapshot: IdentityRunSnapshot;
  // One classification for every route: a refusal the captain can fix answers
  // 400 with its own words, and anything else is a fault the API reports as one.
  try {
    switch (action) {
      case 'start':
        if (!captain(input, send, 'start')) return true;
        snapshot = await run.start();
        break;
      case 'cancel':
        snapshot = await run.cancel();
        break;
      case 'approve': {
        if (!captain(input, send, 'approve')) return true;
        if (typeof input.directionId !== 'string') { send(400, { error: 'A directionId is required.' }); return true; }
        const rationale = typeof input.rationale === 'string' && input.rationale.trim() ? input.rationale : 'Gate 1 aprovado pelo capitão.';
        const override = typeof input.overrideRationale === 'string' ? input.overrideRationale : undefined;
        snapshot = await run.approve({ directionId: input.directionId, approverRole: 'captain', rationale, ...(override ? { overrideRationale: override } : {}) });
        break;
      }
      case 'reject': {
        if (!captain(input, send, 'reject')) return true;
        if (typeof input.directionId !== 'string') { send(400, { error: 'A directionId is required.' }); return true; }
        snapshot = await run.reject({ directionId: input.directionId, approverRole: 'captain', rationale: typeof input.rationale === 'string' ? input.rationale : 'Direção devolvida para revisão.' });
        break;
      }
      case 'token': {
        if (!captain(input, send, 'change a token after')) return true;
        if (typeof input.tokenPath !== 'string') { send(400, { error: 'A tokenPath is required.' }); return true; }
        const parsed = tokenValueSchema.safeParse(input.value);
        if (!parsed.success) { send(400, { error: 'A token change must carry a value the approved token can take.' }); return true; }
        snapshot = await run.changeToken({ tokenPath: input.tokenPath, value: parsed.data, rationale: typeof input.rationale === 'string' ? input.rationale : 'Mudança de token após o gate.' });
        break;
      }
      default:
        send(404, { error: 'Not found.' });
        return true;
    }
  } catch (error) {
    if (!(error instanceof StageError)) throw error;
    send(400, { error: error.message });
    return true;
  }
  send(200, snapshot);
  return true;
}
