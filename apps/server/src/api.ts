import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ChainGateError, type FixtureRun } from './fixture-run.js';
import { handleIdentityRequest, type IdentityApiOptions } from './identity-api.js';
import type { PrototypeRunRegistry } from './prototype-api.js';
import { handlePrototypeRequest } from './prototype-routes.js';
import { RunConflictError } from './run-conflict.js';
import { STUDIO_ORIGIN } from './security.js';

export { RunConflictError };

interface ApiOptions {
  runs: Map<string, FixtureRun>;
  createRun: (id: string) => Promise<FixtureRun>;
  /**
   * The run as the ledger has it. The loader owns the choice between the object
   * this process holds and a fresh read, so it must answer with the cached run
   * whenever that one is authoritative: a run that is measuring, awaiting a
   * decision or holding a prepared release is not rebuildable from rows.
   */
  loadRun?: (id: string) => Promise<FixtureRun | undefined>;
  identity?: IdentityApiOptions;
  prototypes?: PrototypeRunRegistry;
}

const corsHeaders = { 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const allowedOrigins = new Set<string>([STUDIO_ORIGIN]);
function allowedOrigin(origin: string | undefined): string { return origin && allowedOrigins.has(origin) ? origin : STUDIO_ORIGIN; }

function send(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders }); response.end(JSON.stringify(body)); }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 64 * 1024) throw new Error('Request body too large.'); } const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) as Record<string, unknown> : {}; }

export function createApiServer(options: ApiOptions): Server {
  /**
   * The run as the ledger has it: gates 1 and 2 close in their own runs, so a
   * cached chain run with nothing in flight would otherwise answer for an
   * approvals table it has never seen.
   */
  const resolveRun = async (runId: string): Promise<FixtureRun | undefined> =>
    options.loadRun ? await options.loadRun(runId) : options.runs.get(runId);
  return createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin(request.headers.origin));
    if (request.method === 'OPTIONS') { response.writeHead(204, corsHeaders).end(); return; }
    try {
      let pathname: string;
      try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; }
      catch { send(response, 400, { error: 'Malformed request target.' }); return; }
      if (request.method === 'POST' && !allowedOrigins.has(request.headers.origin ?? '')) { send(response, 403, { error: 'State-changing requests must come from the local studio origin.' }); return; }
      if (request.method === 'GET' && pathname === '/health') { response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders }).end('ok'); return; }
      if (options.identity && await handleIdentityRequest(request, response, pathname, options.identity, { send: (status, payload) => send(response, status, payload), body })) return;
      if (request.method === 'POST' && pathname === '/api/runs') {
        const input = await body(request);
        const runId = typeof input.runId === 'string' ? input.runId : `run-${randomUUID()}`;
        if (options.runs.has(runId)) { send(response, 409, { error: `Run ${runId} already exists.` }); return; }
        let created: FixtureRun;
        try { created = await options.createRun(runId); }
        catch (error) { if (error instanceof RunConflictError) { send(response, 409, { error: error.message }); return; } throw error; }
        send(response, 201, { runId, snapshot: created.snapshot() });
        return;
      }
      if (options.prototypes && pathname.startsWith('/api/prototype/')) {
        const handled = await handlePrototypeRequest(options.prototypes, request, pathname, body);
        if (handled) { send(response, handled.status, handled.payload); return; }
      }

      // Gate 3: prepare a release, read the report, and publish the exact bundle
      // the captain looked at. Publishing is what approves the finalization gate.
      const release = /^\/api\/runs\/([^/]+)\/release(?:\/(publish))?$/.exec(pathname);
      if (release) {
        const runId = decodeURIComponent(release[1]!);
        const run = await resolveRun(runId);
        if (!run) { send(response, 404, { error: 'Run not found.' }); return; }
        if (!run.releaseEnabled()) { send(response, 404, { error: 'A finalização não está habilitada neste servidor.' }); return; }
        if (request.method === 'GET' && !release[2]) {
          const snapshot = run.releaseSnapshot();
          if (!snapshot) { send(response, 404, { error: 'O release ainda não foi preparado nesta execução.' }); return; }
          send(response, 200, snapshot);
          return;
        }
        if (request.method !== 'POST') { send(response, 405, { error: 'Method not allowed.' }); return; }
        // Gate 3 never opens before gates 1 and 2 closed, and the bundle is
        // compiled from the version the finalization stage produced.
        const blocker = run.releaseBlocker();
        if (blocker) { send(response, 409, { error: blocker }); return; }
        if (!release[2]) { send(response, 200, await run.prepareRelease()); return; }
        const input = await body(request);
        if (input.approverRole !== 'captain') { send(response, 403, { error: 'Only the captain can approve v1 gates.' }); return; }
        if (typeof input.digest !== 'string') { send(response, 400, { error: 'O digest do bundle aprovado é obrigatório.' }); return; }
        const manifest = await run.publishRelease(input.digest, typeof input.rationale === 'string' ? input.rationale : undefined);
        send(response, 200, { manifest, snapshot: run.releaseSnapshot(), run: run.snapshot() });
        return;
      }

      const match = /^\/api\/runs\/([^/]+)(?:\/(stage|approve|reject|cancel|restart))?$/.exec(pathname);
      if (match) {
        const runId = decodeURIComponent(match[1]!);
        const run = await resolveRun(runId);
        if (!run) { send(response, 404, { error: 'Run not found.' }); return; }
        const action = match[2];
        if (request.method === 'GET' && !action) { send(response, 200, run.snapshot()); return; }
        if (request.method !== 'POST') { send(response, 405, { error: 'Method not allowed.' }); return; }
        if (action === 'stage') { send(response, 200, await run.runNext()); return; }
        if (action === 'cancel') { await run.cancel(); send(response, 200, run.snapshot()); return; }
        if (action === 'restart') { await run.restart(); send(response, 200, run.snapshot()); return; }
        if (action === 'approve') {
          const input = await body(request);
          if (input.approverRole !== 'captain') { send(response, 403, { error: 'Only the captain can approve v1 gates.' }); return; }
          const stage = input.stage ?? run.snapshot().currentStage;
          if (stage !== 'identity' && stage !== 'prototype' && stage !== 'finalization') { send(response, 400, { error: 'A valid stage is required.' }); return; }
          if (stage === 'finalization') { send(response, 409, { error: 'O gate de finalização é o Gate 3: publicar o bundle aprova a etapa.' }); return; }
          send(response, 200, await run.approve(stage, 'captain', typeof input.rationale === 'string' ? input.rationale : undefined));
          return;
        }
        if (action === 'reject') {
          const input = await body(request);
          if (input.approverRole !== 'captain') { send(response, 403, { error: 'Only the captain can reject v1 gates.' }); return; }
          const stage = input.stage ?? run.snapshot().currentStage;
          if (stage !== 'identity' && stage !== 'prototype' && stage !== 'finalization') { send(response, 400, { error: 'A valid stage is required.' }); return; }
          send(response, 200, await run.reject(stage, 'captain', typeof input.rationale === 'string' ? input.rationale : undefined));
          return;
        }
      }
      send(response, 404, { error: 'Not found.' });
    } catch (error) {
      // A gate this route does not own is a conflict, not a server fault: the
      // chain's gates 1 and 2 are decided where they are measured.
      if (error instanceof ChainGateError) { send(response, 409, { error: error.message }); return; }
      send(response, 500, { error: error instanceof Error ? error.message : 'Internal error.' });
    }
  });
}
