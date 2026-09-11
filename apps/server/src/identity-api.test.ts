import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from './index.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { IDENTITY_BRIEFING, IDENTITY_BRIEFING_MAX_LENGTH, INVALID_IDENTITY_BRIEFING, LEGACY_INVALID_BRIEFING_MESSAGE } from './identity-briefing.js';
import { STUDIO_ORIGIN } from './security.js';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

async function identityServer(): Promise<{ origin: string; directory: string; close: () => Promise<void>; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'pwb-identity-api-'));
  const server = await startServer({
    dbPath: join(directory, 'identity.sqlite'),
    renderCacheDir: join(directory, 'render-cache'),
    releaseRoot: join(directory, 'releases'),
    evidenceDir: join(directory, 'evidence'),
    apiPort: 0,
    previewPort: 0,
    modelProvider: 'fake',
  });
  const port = (server.api.address() as AddressInfo).port;
  const close = async (): Promise<void> => { await server.close(); };
  const cleanup = async (): Promise<void> => { await close(); await rm(directory, { recursive: true, force: true }); };
  servers.push({ close: cleanup });
  return { origin: `http://127.0.0.1:${port}`, directory, close, cleanup };
}

function postIdentity(origin: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${origin}/api/identity/runs`, {
    method: 'POST',
    headers: { origin: STUDIO_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** `start` returns the running snapshot, so a test reads the outcome the way the studio does. */
async function settled(origin: string, runId: string): Promise<{ status: string; gate: { state: string }; failures: Array<unknown> }> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const response = await fetch(`${origin}/api/identity/runs/${runId}`, { headers: { origin: STUDIO_ORIGIN } });
    const snapshot = await response.json() as { status: string; gate: { state: string }; failures: Array<unknown> };
    if (snapshot.status !== 'running' && snapshot.status !== 'queued') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Identity run ${runId} never settled.`);
}

describe('identity run creation', () => {
  it('opens Gate 1 through HTTP with the default critic deadline policy', async () => {
    const server = await identityServer();
    const created = await postIdentity(server.origin, { runId: 'default-deadline-api' });
    expect(created.status).toBe(201);

    const started = await fetch(`${server.origin}/api/identity/runs/default-deadline-api/start`, {
      method: 'POST',
      headers: { origin: STUDIO_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ approverRole: 'captain' }),
    });
    // The start answers as soon as the stage is under way; the gate is read by polling.
    expect(started.status).toBe(200);
    expect((await started.json() as { status: string }).status).toBe('running');
    const snapshot = await settled(server.origin, 'default-deadline-api');

    expect(snapshot.status).toBe('needs_review');
    expect(snapshot.gate.state).toBe('open');
    expect(snapshot.failures).toEqual([]);

    const database = openDatabase(join(server.directory, 'identity.sqlite'));
    try {
      const events = await new ProjectRepository(database).listEvents('default-deadline-api');
      const queued = events.filter((event) => event.type === 'identity.task.queued');
      const deadlineOf = (taskId: string): unknown => queued.find((event) => event.payload.taskId === taskId)?.payload.deadlineMs;
      expect(deadlineOf('identity-critic-brand-fit-critic-editorial-material')).toBe(3 * 60_000);
      expect(deadlineOf('identity-critic-divergence-critic')).toBe(3 * 60_000);
      expect(deadlineOf('identity-critic-system-a11y-critic-editorial-material')).toBe(10 * 60_000);
    } finally {
      database.sqlite.close();
    }
  });

  it('trims and persists a free briefing in the Gate 1 snapshot', async () => {
    const server = await identityServer();
    const response = await postIdentity(server.origin, { runId: 'briefing-api', briefing: '  Um nicho de cerâmica autoral.  ' });

    expect(response.status).toBe(201);
    expect((await response.json() as { briefing: string }).briefing).toBe('Um nicho de cerâmica autoral.');
  });

  it('keeps the explicit legacy default only when old callers omit briefing', async () => {
    const server = await identityServer();
    const response = await postIdentity(server.origin, { runId: 'legacy-api' });

    expect(response.status).toBe(201);
    expect((await response.json() as { briefing: string }).briefing).toBe(IDENTITY_BRIEFING);
  });

  it('rejects blank, non-string, and overlong briefings with actionable 4xx responses', async () => {
    const server = await identityServer();
    const blank = await postIdentity(server.origin, { runId: 'blank-api', briefing: ' \n\t ' });
    const nonString = await postIdentity(server.origin, { runId: 'non-string-api', briefing: 42 });
    const tooLong = await postIdentity(server.origin, { runId: 'long-api', briefing: 'a'.repeat(IDENTITY_BRIEFING_MAX_LENGTH + 1) });

    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: 'O briefing é obrigatório e não pode estar vazio.' });
    expect(nonString.status).toBe(400);
    expect(await nonString.json()).toEqual({ error: 'O briefing deve ser um texto.' });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: `O briefing não pode ter mais de ${IDENTITY_BRIEFING_MAX_LENGTH} caracteres.` });
  });

  it('restores the exact briefing after the server restarts', async () => {
    const first = await identityServer();
    const created = await postIdentity(first.origin, { runId: 'briefing-restart', briefing: 'Nicho editorial para oficinas de bairro.' });
    expect(created.status).toBe(201);
    await first.close();
    servers.splice(servers.findIndex((entry) => entry.close === first.cleanup), 1);

    const second = await startServer({
      dbPath: join(first.directory, 'identity.sqlite'),
      renderCacheDir: join(first.directory, 'render-cache-2'),
      releaseRoot: join(first.directory, 'releases-2'),
      evidenceDir: join(first.directory, 'evidence-2'),
      apiPort: 0,
      previewPort: 0,
      modelProvider: 'fake',
    });
    const port = (second.api.address() as AddressInfo).port;
    servers.push({ close: async () => { await second.close(); await rm(first.directory, { recursive: true, force: true }); } });
    const restored = await fetch(`http://127.0.0.1:${port}/api/identity/runs/briefing-restart`);

    expect(restored.status).toBe(200);
    expect((await restored.json() as { briefing: string }).briefing).toBe('Nicho editorial para oficinas de bairro.');
  });

  it('serves invalid legacy briefings as irrecoverable without deleting their rows', async () => {
    const first = await identityServer();
    const runIds = ['legacy-blank', 'legacy-too-long'];
    for (const runId of runIds) expect((await postIdentity(first.origin, { runId })).status).toBe(201);
    await first.close();
    servers.splice(servers.findIndex((entry) => entry.close === first.cleanup), 1);

    const legacy = openDatabase(join(first.directory, 'identity.sqlite'));
    legacy.sqlite.prepare('UPDATE runs SET briefing = ? WHERE id = ?').run(' \n\t ', 'legacy-blank');
    const overlong = 'a'.repeat(IDENTITY_BRIEFING_MAX_LENGTH + 1);
    legacy.sqlite.prepare('UPDATE runs SET briefing = ? WHERE id = ?').run(overlong, 'legacy-too-long');
    legacy.sqlite.close();

    const second = await startServer({
      dbPath: join(first.directory, 'identity.sqlite'),
      renderCacheDir: join(first.directory, 'render-cache-2'),
      releaseRoot: join(first.directory, 'releases-2'),
      evidenceDir: join(first.directory, 'evidence-2'),
      apiPort: 0,
      previewPort: 0,
      modelProvider: 'fake',
    });
    const port = (second.api.address() as AddressInfo).port;
    servers.push({ close: async () => { await second.close(); await rm(first.directory, { recursive: true, force: true }); } });

    for (const runId of runIds) {
      const restored = await fetch(`http://127.0.0.1:${port}/api/identity/runs/${runId}`);
      const snapshot = await restored.json() as { status: string; briefing: string; error?: string };
      expect(restored.status).toBe(200);
      expect(snapshot.status).toBe('unrecoverable');
      expect(snapshot.error).toBe(LEGACY_INVALID_BRIEFING_MESSAGE);
      expect(snapshot.briefing).toBe(INVALID_IDENTITY_BRIEFING);
      expect(snapshot.briefing).not.toBe(IDENTITY_BRIEFING);
      const retry = await fetch(`http://127.0.0.1:${port}/api/identity/runs/${runId}/start`, { method: 'POST', headers: { origin: STUDIO_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ approverRole: 'captain' }) });
      expect(retry.status).toBe(400);
      expect(await retry.json()).toEqual({ error: LEGACY_INVALID_BRIEFING_MESSAGE });
    }

    const preserved = openDatabase(join(first.directory, 'identity.sqlite'));
    try {
      expect((preserved.sqlite.prepare('SELECT briefing FROM runs WHERE id = ?').get('legacy-blank') as { briefing: string }).briefing).toBe(' \n\t ');
      expect((preserved.sqlite.prepare('SELECT briefing FROM runs WHERE id = ?').get('legacy-too-long') as { briefing: string }).briefing).toBe(overlong);
    } finally {
      preserved.sqlite.close();
    }
  });

  it('answers 404 for a /confirm suffix on any action but the conversation, without reaching the handler', async () => {
    const server = await identityServer();
    expect((await postIdentity(server.origin, { runId: 'sufixo-confirm' })).status).toBe(201);

    for (const action of ['start', 'cancel', 'approve', 'reject', 'token']) {
      const response = await fetch(`${server.origin}/api/identity/runs/sufixo-confirm/${action}/confirm`, {
        method: 'POST',
        headers: { origin: STUDIO_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ approverRole: 'captain', directionId: 'editorial-material', tokenPath: '/identity/tokens/color/ink', value: { $value: '#123456', $type: 'color' } }),
      });
      expect(response.status).toBe(404);
    }

    // Nothing ran: no fan-out was bought and no decision was recorded.
    const snapshot = await (await fetch(`${server.origin}/api/identity/runs/sufixo-confirm`, { headers: { origin: STUDIO_ORIGIN } })).json() as { status: string; directions: unknown[]; approvals: unknown[] };
    expect(snapshot.status).toBe('queued');
    expect(snapshot.directions).toEqual([]);
    expect(snapshot.approvals).toEqual([]);
    // The suffix the conversation owns still routes.
    expect((await fetch(`${server.origin}/api/identity/runs/sufixo-confirm/conversation`, { headers: { origin: STUDIO_ORIGIN } })).status).toBe(200);
  });
});
