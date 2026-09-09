import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from './index.js';
import { IDENTITY_BRIEFING, IDENTITY_BRIEFING_MAX_LENGTH } from './identity-briefing.js';
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

describe('identity run creation', () => {
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
});
