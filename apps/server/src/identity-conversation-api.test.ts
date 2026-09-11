import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { briefingConversationConfirmPath, briefingConversationPath, IDENTITY_BRIEFING, IDENTITY_BRIEFING_MAX_LENGTH, type BriefingConversationSnapshot } from '@pwb/domain';
import { startServer } from './index.js';
import { STUDIO_ORIGIN } from './security.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface Harness { origin: string; directory: string; close: () => Promise<void> }

async function conversationServer(directory?: string): Promise<Harness> {
  const root = directory ?? await mkdtemp(join(tmpdir(), 'pwb-conversation-api-'));
  const server = await startServer({
    dbPath: join(root, 'identity.sqlite'),
    renderCacheDir: join(root, 'render-cache'),
    releaseRoot: join(root, 'releases'),
    evidenceDir: join(root, 'evidence'),
    apiPort: 0,
    previewPort: 0,
    modelProvider: 'fake',
  });
  const port = (server.api.address() as AddressInfo).port;
  // Closing twice is normal here: a restart test closes the server itself and
  // the afterEach hook closes whatever is left.
  let closed = false;
  const close = async (): Promise<void> => { if (closed) return; closed = true; await server.close(); };
  cleanups.push(async () => { await close(); if (!directory) await rm(root, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${port}`, directory: root, close };
}

function post(origin: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${origin}${path}`, { method: 'POST', headers: { origin: STUDIO_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function createRun(origin: string, runId: string, briefing?: string): Promise<void> {
  const created = await post(origin, '/api/identity/runs', { runId, ...(briefing === undefined ? {} : { briefing }) });
  expect(created.status).toBe(201);
}

async function snapshotOf(response: Response): Promise<BriefingConversationSnapshot> {
  return await response.json() as BriefingConversationSnapshot;
}

const FIRST_TEXT = 'Somos uma clínica veterinária de bairro. Queremos cuidar de cães e gatos com prevenção, sem parecer hospital frio nem pet shop genérico.';

describe('briefing conversation API', () => {
  it('opens the conversation from the text the execution was created with', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-entrada', FIRST_TEXT);

    const opened = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-entrada'), { idempotencyKey: 'turn-1' }));

    expect(opened.runId).toBe('conversa-entrada');
    expect(opened.state).toBe('recommendation');
    expect(opened.normalizedText).toBe(FIRST_TEXT);
    expect(opened.messages).toHaveLength(2);
    expect(opened.messages[1]?.author).toBe('studio');
    expect(opened.messages[1]?.turn?.intent).toBe('recommendation');
  });

  it('resumes the history on GET without spending a turn', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-retomada', FIRST_TEXT);
    await post(server.origin, briefingConversationPath('conversa-retomada'), { idempotencyKey: 'turn-1' });

    const resumed = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-retomada')}`, { headers: { origin: STUDIO_ORIGIN } }));

    expect(resumed.state).toBe('recommendation');
    expect(resumed.messages).toHaveLength(2);
  });

  it('walks the whole conversation and closes the briefing with three conceptual directions', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-completa', FIRST_TEXT);
    await post(server.origin, briefingConversationPath('conversa-completa'), { idempotencyKey: 'turn-1' });

    const asked = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-completa'), { message: 'A prevenção é o centro do que fazemos.', idempotencyKey: 'turn-2' }));
    expect(asked.state).toBe('question');
    expect(asked.messages.at(-1)?.turn?.question?.why).toBeTruthy();

    const answered = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-completa'), { message: 'Segurança clínica sem perder o carinho.', idempotencyKey: 'turn-3' }));
    expect(answered.state).toBe('recommendation');

    const offered = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-completa'), { message: 'Queremos ser lembrados pelo acompanhamento.', idempotencyKey: 'turn-4' }));
    expect(offered.state).toBe('confirmation');
    expect(offered.summary).toBeTruthy();

    const closed = await snapshotOf(await post(server.origin, briefingConversationConfirmPath('conversa-completa'), { briefing: `${offered.summary!} Confirmado pelo capitão.`, idempotencyKey: 'confirm-1' }));
    expect(closed.state).toBe('final');
    expect(closed.confirmations).toHaveLength(1);
    expect(closed.directions).toHaveLength(3);
    for (const direction of closed.directions) {
      expect(direction.positioning).toBeTruthy();
      expect(direction.palette).toBeTruthy();
      expect(direction.applications.length).toBeGreaterThan(0);
    }
  });

  it('carries the confirmed briefing onto the execution, which is what enables the identity stage', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-briefing', FIRST_TEXT);
    await post(server.origin, briefingConversationPath('conversa-briefing'), { idempotencyKey: 'turn-1' });
    await post(server.origin, briefingConversationPath('conversa-briefing'), { message: 'A prevenção é o centro.', idempotencyKey: 'turn-2' });
    await post(server.origin, briefingConversationPath('conversa-briefing'), { message: 'Segurança clínica com carinho.', idempotencyKey: 'turn-3' });
    await post(server.origin, briefingConversationPath('conversa-briefing'), { message: 'Acompanhamento é a promessa.', idempotencyKey: 'turn-4' });

    await post(server.origin, briefingConversationConfirmPath('conversa-briefing'), { briefing: 'Clínica de bairro preventiva, com autoridade clínica e proximidade cotidiana.', idempotencyKey: 'confirm-1' });
    const run = await (await fetch(`${server.origin}/api/identity/runs/conversa-briefing`, { headers: { origin: STUDIO_ORIGIN } })).json() as { briefing: string };
    const conversation = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-briefing')}`, { headers: { origin: STUDIO_ORIGIN } }));

    // The execution carries exactly the text the captain signed; the gaps the
    // fixture leaves open travel beside it, in the confirmation record.
    expect(run.briefing).toBe('Clínica de bairro preventiva, com autoridade clínica e proximidade cotidiana.');
    expect(conversation.confirmations[0]?.openGaps.length).toBeGreaterThan(0);
    expect(conversation.state).toBe('final');
  });

  it('freezes the briefing once the identity stage has started, instead of recording a revision nobody applies', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-congelada', FIRST_TEXT);
    await post(server.origin, briefingConversationPath('conversa-congelada'), { idempotencyKey: 'turn-1' });
    await post(server.origin, briefingConversationPath('conversa-congelada'), { message: 'A prevenção é o centro.', idempotencyKey: 'turn-2' });
    await post(server.origin, briefingConversationPath('conversa-congelada'), { message: 'Segurança clínica com carinho.', idempotencyKey: 'turn-3' });
    await post(server.origin, briefingConversationPath('conversa-congelada'), { message: 'Acompanhamento é a promessa.', idempotencyKey: 'turn-4' });
    await post(server.origin, briefingConversationConfirmPath('conversa-congelada'), { briefing: 'Clínica de bairro preventiva, com acompanhamento contínuo.', idempotencyKey: 'confirm-1' });
    const started = await post(server.origin, '/api/identity/runs/conversa-congelada/start', { approverRole: 'captain' });
    expect(started.status).toBe(200);

    const late = await post(server.origin, briefingConversationConfirmPath('conversa-congelada'), { briefing: 'Outro briefing, escrito depois da largada.', idempotencyKey: 'confirm-2' });

    expect(late.status).toBe(409);
    expect((await late.json() as { error: string }).error).toMatch(/congelado/);
    const run = await (await fetch(`${server.origin}/api/identity/runs/conversa-congelada`, { headers: { origin: STUDIO_ORIGIN } })).json() as { briefing: string };
    expect(run.briefing).toBe('Clínica de bairro preventiva, com acompanhamento contínuo.');
    const conversation = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-congelada')}`, { headers: { origin: STUDIO_ORIGIN } }));
    expect(conversation.confirmations).toHaveLength(1);
  });

  it('never duplicates a turn when the same idempotency key is retried', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-idempotente', FIRST_TEXT);

    const first = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-idempotente'), { idempotencyKey: 'retry' }));
    const second = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-idempotente'), { idempotencyKey: 'retry' }));

    expect(second.messages).toHaveLength(first.messages.length);
    expect(second.messages).toEqual(first.messages);
  });

  it('refuses a body without an idempotency key, an empty message or an oversized one', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-invalida', FIRST_TEXT);

    const missingKey = await post(server.origin, briefingConversationPath('conversa-invalida'), { message: 'Olá.' });
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json() as { error: string }).error).toContain('idempotencyKey');

    const tooLong = await post(server.origin, briefingConversationPath('conversa-invalida'), { message: 'x'.repeat(IDENTITY_BRIEFING_MAX_LENGTH + 1), idempotencyKey: 'k' });
    expect(tooLong.status).toBe(400);

    await post(server.origin, briefingConversationPath('conversa-invalida'), { idempotencyKey: 'turn-1' });
    const empty = await post(server.origin, briefingConversationPath('conversa-invalida'), { message: '   ', idempotencyKey: 'k2' });
    expect(empty.status).toBe(400);
    expect((await empty.json() as { error: string }).error).toContain('não pode estar vazia');

    const unknownField = await post(server.origin, briefingConversationPath('conversa-invalida'), { message: 'Olá.', idempotencyKey: 'k3', preview: true });
    expect(unknownField.status).toBe(400);
  });

  it('stops the conversation on cancel and keeps the execution reopenable', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-cancelada', FIRST_TEXT);
    await post(server.origin, briefingConversationPath('conversa-cancelada'), { idempotencyKey: 'turn-1' });

    const cancelled = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-cancelada'), { action: 'cancel', idempotencyKey: 'cancel-1' }));
    expect(cancelled.state).toBe('cancelled');

    const refused = await post(server.origin, briefingConversationPath('conversa-cancelada'), { message: 'Mais uma coisa.', idempotencyKey: 'turn-2' });
    expect(refused.status).toBe(409);

    const run = await fetch(`${server.origin}/api/identity/runs/conversa-cancelada`, { headers: { origin: STUDIO_ORIGIN } });
    expect(run.status).toBe(200);
  });

  it('answers 404 for a conversation on an execution that does not exist', async () => {
    const server = await conversationServer();

    const missing = await fetch(`${server.origin}${briefingConversationPath('nao-existe')}`, { headers: { origin: STUDIO_ORIGIN } });

    expect(missing.status).toBe(404);
  });

  it('keeps the fixed compatibility briefing for a caller that omits the field', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-legada');

    const run = await (await fetch(`${server.origin}/api/identity/runs/conversa-legada`, { headers: { origin: STUDIO_ORIGIN } })).json() as { briefing: string };
    const conversation = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-legada')}`, { headers: { origin: STUDIO_ORIGIN } }));

    expect(run.briefing).toBe(IDENTITY_BRIEFING);
    expect(conversation.state).toBe('entry');
    expect(conversation.messages).toEqual([]);
  });

  it('generates no preview and no version while the conversation runs', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-sem-preview', FIRST_TEXT);
    await post(server.origin, briefingConversationPath('conversa-sem-preview'), { idempotencyKey: 'turn-1' });
    await post(server.origin, briefingConversationPath('conversa-sem-preview'), { message: 'A prevenção é o centro.', idempotencyKey: 'turn-2' });
    await post(server.origin, briefingConversationPath('conversa-sem-preview'), { message: 'Segurança clínica com carinho.', idempotencyKey: 'turn-3' });
    await post(server.origin, briefingConversationPath('conversa-sem-preview'), { message: 'Acompanhamento é a promessa.', idempotencyKey: 'turn-4' });
    await post(server.origin, briefingConversationConfirmPath('conversa-sem-preview'), { briefing: 'Clínica de bairro preventiva.', idempotencyKey: 'confirm-1' });

    const run = await (await fetch(`${server.origin}/api/identity/runs/conversa-sem-preview`, { headers: { origin: STUDIO_ORIGIN } })).json() as { status: string; directions: unknown[]; previewVersionId?: string; gate: { state: string } };
    const conversation = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-sem-preview')}`, { headers: { origin: STUDIO_ORIGIN } }));

    expect(run.status).toBe('queued');
    expect(run.directions).toEqual([]);
    expect(run.previewVersionId).toBeUndefined();
    expect(run.gate.state).toBe('open');
    expect(conversation.directions).toHaveLength(3);
  });
});

describe('briefing conversation restart', () => {
  it('rebuilds the text, history, state and summary from the execution after a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-conversation-restart-'));
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); });
    const first = await conversationServer(directory);
    await createRun(first.origin, 'conversa-reinicio', FIRST_TEXT);
    await post(first.origin, briefingConversationPath('conversa-reinicio'), { idempotencyKey: 'turn-1' });
    const before = await snapshotOf(await post(first.origin, briefingConversationPath('conversa-reinicio'), { message: 'A prevenção é o centro.', idempotencyKey: 'turn-2' }));
    await first.close();

    const second = await conversationServer(directory);
    const after = await snapshotOf(await fetch(`${second.origin}${briefingConversationPath('conversa-reinicio')}`, { headers: { origin: STUDIO_ORIGIN } }));

    expect(after.state).toBe(before.state);
    expect(after.normalizedText).toBe(FIRST_TEXT);
    expect(after.messages).toEqual(before.messages);
    expect(after.askedQuestions).toEqual(before.askedQuestions);
    expect(after.summary).toBe(before.summary);
  });

  it('opens from the execution text when the restart happened before the first turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-conversation-restart-entry-'));
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); });
    const first = await conversationServer(directory);
    await createRun(first.origin, 'conversa-sem-turno', FIRST_TEXT);
    await first.close();

    const second = await conversationServer(directory);
    const response = await post(second.origin, briefingConversationPath('conversa-sem-turno'), { idempotencyKey: 'turn-1' });
    const opened = await snapshotOf(response);

    expect(response.status).toBe(200);
    expect(opened.normalizedText).toBe(FIRST_TEXT);
    expect(opened.state).toBe('recommendation');
  });

  it('does not buy a second turn for a key that was already applied before the restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-conversation-restart-key-'));
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); });
    const first = await conversationServer(directory);
    await createRun(first.origin, 'conversa-chave', FIRST_TEXT);
    const before = await snapshotOf(await post(first.origin, briefingConversationPath('conversa-chave'), { idempotencyKey: 'survives-restart' }));
    await first.close();

    const second = await conversationServer(directory);
    const retried = await snapshotOf(await post(second.origin, briefingConversationPath('conversa-chave'), { idempotencyKey: 'survives-restart' }));

    expect(retried.messages).toEqual(before.messages);
  });

  it('restores a confirmed briefing as a stable record a restart cannot rewrite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-conversation-restart-confirm-'));
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); });
    const first = await conversationServer(directory);
    await createRun(first.origin, 'conversa-confirmada', FIRST_TEXT);
    await post(first.origin, briefingConversationPath('conversa-confirmada'), { idempotencyKey: 'turn-1' });
    await post(first.origin, briefingConversationPath('conversa-confirmada'), { message: 'A prevenção é o centro.', idempotencyKey: 'turn-2' });
    await post(first.origin, briefingConversationPath('conversa-confirmada'), { message: 'Segurança clínica com carinho.', idempotencyKey: 'turn-3' });
    await post(first.origin, briefingConversationPath('conversa-confirmada'), { message: 'Acompanhamento é a promessa.', idempotencyKey: 'turn-4' });
    await post(first.origin, briefingConversationConfirmPath('conversa-confirmada'), { briefing: 'Primeira versão confirmada.', idempotencyKey: 'confirm-1' });
    await first.close();

    const second = await conversationServer(directory);
    const revised = await snapshotOf(await post(second.origin, briefingConversationConfirmPath('conversa-confirmada'), { briefing: 'Segunda versão, corrigida depois do restart.', idempotencyKey: 'confirm-2' }));

    expect(revised.confirmations.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(revised.confirmations[0]?.briefing).toContain('Primeira versão confirmada.');
    expect(revised.confirmations[1]?.briefing).toContain('Segunda versão, corrigida depois do restart.');
    expect(revised.briefing).toContain('Segunda versão, corrigida depois do restart.');
  });
});
