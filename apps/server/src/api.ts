import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { FixtureRun } from './fixture-run.js';
import { STUDIO_ORIGIN } from './security.js';

interface ApiOptions { runs: Map<string, FixtureRun>; createRun: (id: string) => Promise<FixtureRun>; }
const corsHeaders = { 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const allowedOrigins = new Set<string>([STUDIO_ORIGIN]);
function allowedOrigin(origin: string | undefined): string { return origin && allowedOrigins.has(origin) ? origin : STUDIO_ORIGIN; }

function send(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders }); response.end(JSON.stringify(body)); }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 64 * 1024) throw new Error('Request body too large.'); } const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) as Record<string, unknown> : {}; }

export function createApiServer(options: ApiOptions): Server {
  return createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin(request.headers.origin));
    if (request.method === 'OPTIONS') { response.writeHead(204, corsHeaders).end(); return; }
    try {
      let pathname: string;
      try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; }
      catch { send(response, 400, { error: 'Malformed request target.' }); return; }
      if (request.method === 'POST' && !allowedOrigins.has(request.headers.origin ?? '')) { send(response, 403, { error: 'State-changing requests must come from the local studio origin.' }); return; }
      if (request.method === 'GET' && pathname === '/health') { response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders }).end('ok'); return; }
      if (request.method === 'POST' && pathname === '/api/runs') {
        const input = await body(request);
        const runId = typeof input.runId === 'string' ? input.runId : `run-${randomUUID()}`;
        const run = await options.createRun(runId);
        send(response, 201, { runId, snapshot: run.snapshot() });
        return;
      }
      const match = /^\/api\/runs\/([^/]+)(?:\/(stage|approve|reject|cancel|restart))?$/.exec(pathname);
      if (match) {
        const run = options.runs.get(decodeURIComponent(match[1]!));
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
    } catch (error) { send(response, 500, { error: error instanceof Error ? error.message : 'Internal error.' }); }
  });
}
