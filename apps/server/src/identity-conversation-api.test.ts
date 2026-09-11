import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { briefingConversationConfirmPath, briefingConversationPath, briefingConversationReopenPath, IDENTITY_BRIEFING, IDENTITY_BRIEFING_MAX_LENGTH, type BriefingConversationSnapshot } from '@pwb/domain';
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

/** The four turns the fixture conversation needs to reach the editable summary a captain may sign. */
async function driveToConfirmation(origin: string, runId: string, prefix = 'turn'): Promise<BriefingConversationSnapshot> {
  const messages = [undefined, 'A prevenção é o centro.', 'Segurança clínica com carinho.', 'Acompanhamento é a promessa.'];
  let snapshot!: BriefingConversationSnapshot;
  for (const [index, message] of messages.entries()) {
    snapshot = await snapshotOf(await post(origin, briefingConversationPath(runId), { approverRole: 'captain', ...(message === undefined ? {} : { message }), idempotencyKey: `${prefix}-${index}` }));
  }
  expect(snapshot.state).toBe('confirmation');
  return snapshot;
}

const FIRST_TEXT = 'Somos uma clínica veterinária de bairro. Queremos cuidar de cães e gatos com prevenção, sem parecer hospital frio nem pet shop genérico.';

describe('briefing conversation API', () => {
  it('opens the conversation from the text the execution was created with', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-entrada', FIRST_TEXT);

    const opened = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-entrada'), { approverRole: 'captain', idempotencyKey: 'turn-1' }));

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
    await post(server.origin, briefingConversationPath('conversa-retomada'), { approverRole: 'captain', idempotencyKey: 'turn-1' });

    const resumed = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-retomada')}`, { headers: { origin: STUDIO_ORIGIN } }));

    expect(resumed.state).toBe('recommendation');
    expect(resumed.messages).toHaveLength(2);
  });

  it('walks the whole conversation and closes the briefing with three conceptual directions', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-completa', FIRST_TEXT);
    await post(server.origin, briefingConversationPath('conversa-completa'), { approverRole: 'captain', idempotencyKey: 'turn-1' });

    const asked = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-completa'), { approverRole: 'captain', message: 'A prevenção é o centro do que fazemos.', idempotencyKey: 'turn-2' }));
    expect(asked.state).toBe('question');
    expect(asked.messages.at(-1)?.turn?.question?.why).toBeTruthy();

    const answered = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-completa'), { approverRole: 'captain', message: 'Segurança clínica sem perder o carinho.', idempotencyKey: 'turn-3' }));
    expect(answered.state).toBe('recommendation');

    const offered = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-completa'), { approverRole: 'captain', message: 'Queremos ser lembrados pelo acompanhamento.', idempotencyKey: 'turn-4' }));
    expect(offered.state).toBe('confirmation');
    expect(offered.summary).toBeTruthy();

    const closed = await snapshotOf(await post(server.origin, briefingConversationConfirmPath('conversa-completa'), { approverRole: 'captain', briefing: `${offered.summary!} Confirmado pelo capitão.`, idempotencyKey: 'confirm-1' }));
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
    await post(server.origin, briefingConversationPath('conversa-briefing'), { approverRole: 'captain', idempotencyKey: 'turn-1' });
    await post(server.origin, briefingConversationPath('conversa-briefing'), { approverRole: 'captain', message: 'A prevenção é o centro.', idempotencyKey: 'turn-2' });
    await post(server.origin, briefingConversationPath('conversa-briefing'), { approverRole: 'captain', message: 'Segurança clínica com carinho.', idempotencyKey: 'turn-3' });
    await post(server.origin, briefingConversationPath('conversa-briefing'), { approverRole: 'captain', message: 'Acompanhamento é a promessa.', idempotencyKey: 'turn-4' });

    await post(server.origin, briefingConversationConfirmPath('conversa-briefing'), { approverRole: 'captain', briefing: 'Clínica de bairro preventiva, com autoridade clínica e proximidade cotidiana.', idempotencyKey: 'confirm-1' });
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
    await post(server.origin, briefingConversationPath('conversa-congelada'), { approverRole: 'captain', idempotencyKey: 'turn-1' });
    await post(server.origin, briefingConversationPath('conversa-congelada'), { approverRole: 'captain', message: 'A prevenção é o centro.', idempotencyKey: 'turn-2' });
    await post(server.origin, briefingConversationPath('conversa-congelada'), { approverRole: 'captain', message: 'Segurança clínica com carinho.', idempotencyKey: 'turn-3' });
    await post(server.origin, briefingConversationPath('conversa-congelada'), { approverRole: 'captain', message: 'Acompanhamento é a promessa.', idempotencyKey: 'turn-4' });
    await post(server.origin, briefingConversationConfirmPath('conversa-congelada'), { approverRole: 'captain', briefing: 'Clínica de bairro preventiva, com acompanhamento contínuo.', idempotencyKey: 'confirm-1' });
    const started = await post(server.origin, '/api/identity/runs/conversa-congelada/start', { approverRole: 'captain' });
    expect(started.status).toBe(200);

    const late = await post(server.origin, briefingConversationConfirmPath('conversa-congelada'), { approverRole: 'captain', briefing: 'Outro briefing, escrito depois da largada.', idempotencyKey: 'confirm-2' });
    // The same rule holds at the boundary every turn passes through, so the two
    // routes send the captain to the same place instead of to a revision the
    // confirmation would refuse.
    const turn = await post(server.origin, briefingConversationPath('conversa-congelada'), { approverRole: 'captain', message: 'Pensando melhor, mudamos de ideia.', idempotencyKey: 'turn-5' });

    expect(turn.status).toBe(409);
    expect(late.status).toBe(409);
    const frozen = (await late.json() as { error: string }).error;
    expect(frozen).toMatch(/congelado/);
    expect((await turn.json() as { error: string }).error).toBe(frozen);
    const run = await (await fetch(`${server.origin}/api/identity/runs/conversa-congelada`, { headers: { origin: STUDIO_ORIGIN } })).json() as { briefing: string };
    expect(run.briefing).toBe('Clínica de bairro preventiva, com acompanhamento contínuo.');
    const conversation = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-congelada')}`, { headers: { origin: STUDIO_ORIGIN } }));
    expect(conversation.confirmations).toHaveLength(1);
  });

  it('refuses to start the identity stage while the conversation is still open', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-em-curso', FIRST_TEXT);
    const opened = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-em-curso'), { approverRole: 'captain', idempotencyKey: 'turn-1' }));
    expect(opened.state).toBe('recommendation');

    const refused = await post(server.origin, '/api/identity/runs/conversa-em-curso/start', { approverRole: 'captain' });

    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: string }).error).toMatch(/ainda está aberta/);
    // Nothing was curated and nothing was spent: the conversation is exactly
    // where the captain left it.
    const conversation = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-em-curso')}`, { headers: { origin: STUDIO_ORIGIN } }));
    expect(conversation.state).toBe('recommendation');
    expect(conversation.messages).toHaveLength(2);
    const run = await (await fetch(`${server.origin}/api/identity/runs/conversa-em-curso`, { headers: { origin: STUDIO_ORIGIN } })).json() as { directions: unknown[]; status: string };
    expect(run.directions).toEqual([]);
    expect(run.status).toBe('queued');
  });

  it('opens the next conversation on an execution a cancel left reopenable, and starts on what it signs', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-reaberta', FIRST_TEXT);
    await driveToConfirmation(server.origin, 'conversa-reaberta');
    const cancelled = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-reaberta'), { approverRole: 'captain', action: 'cancel', idempotencyKey: 'cancel-1' }));
    expect(cancelled.state).toBe('cancelled');
    // A cancelled conversation signed nothing, so the stage has nothing to run.
    const refused = await post(server.origin, '/api/identity/runs/conversa-reaberta/start', { approverRole: 'captain' });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: string }).error).toMatch(/foi cancelada/);

    const reopened = await post(server.origin, briefingConversationReopenPath('conversa-reaberta'), { approverRole: 'captain', idempotencyKey: 'reopen-1' });

    expect(reopened.status).toBe(200);
    const next = await snapshotOf(reopened);
    expect(next.state).toBe('entry');
    expect(next.revision).toBe(2);
    // The execution was never deleted and the round it closed is still readable.
    expect(next.previousRevisions[0]?.closedAs).toBe('cancelled');
    expect(next.previousRevisions[0]?.messages).toEqual(cancelled.messages);

    await driveToConfirmation(server.origin, 'conversa-reaberta', 'again');
    await post(server.origin, briefingConversationConfirmPath('conversa-reaberta'), { approverRole: 'captain', briefing: 'Segunda conversa: clínica de bairro preventiva, com acompanhamento contínuo.', idempotencyKey: 'confirm-1' });
    const started = await post(server.origin, '/api/identity/runs/conversa-reaberta/start', { approverRole: 'captain' });

    expect(started.status).toBe(200);
    expect((await started.json() as { briefing: string }).briefing).toBe('Segunda conversa: clínica de bairro preventiva, com acompanhamento contínuo.');
  });

  it('refuses a reopen of a conversation that is still open, and one without an idempotency key', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-aberta-demais', FIRST_TEXT);
    await post(server.origin, briefingConversationPath('conversa-aberta-demais'), { approverRole: 'captain', idempotencyKey: 'turn-1' });

    const open = await post(server.origin, briefingConversationReopenPath('conversa-aberta-demais'), { approverRole: 'captain', idempotencyKey: 'reopen-1' });
    const keyless = await post(server.origin, briefingConversationReopenPath('conversa-aberta-demais'), { approverRole: 'captain' });

    expect(open.status).toBe(409);
    expect((await open.json() as { error: string }).error).toMatch(/ainda está aberta/);
    expect(keyless.status).toBe(400);
    const conversation = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-aberta-demais')}`, { headers: { origin: STUDIO_ORIGIN } }));
    expect(conversation.revision).toBe(1);
    expect(conversation.previousRevisions).toEqual([]);
  });

  it('refuses a confirmation that does not carry the captain, and signs nothing', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-sem-capitao', FIRST_TEXT);
    const offered = await driveToConfirmation(server.origin, 'conversa-sem-capitao');

    const anonymous = await post(server.origin, briefingConversationConfirmPath('conversa-sem-capitao'), { briefing: `${offered.summary!} Confirmado por alguém.`, idempotencyKey: 'confirm-1' });

    expect(anonymous.status).toBe(403);
    const conversation = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-sem-capitao')}`, { headers: { origin: STUDIO_ORIGIN } }));
    expect(conversation.state).toBe('confirmation');
    expect(conversation.confirmations).toEqual([]);
    // The refusal spent no key either, so the captain closes the briefing with
    // the same one once they sign it.
    const signed = await snapshotOf(await post(server.origin, briefingConversationConfirmPath('conversa-sem-capitao'), { approverRole: 'captain', briefing: `${offered.summary!} Confirmado pelo capitão.`, idempotencyKey: 'confirm-1' }));
    expect(signed.state).toBe('final');
    expect(signed.confirmations).toHaveLength(1);
  });

  it('refuses a turn and a reopen that do not carry the captain, and spends nothing on them', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-sem-papel', FIRST_TEXT);

    const anonymousTurn = await post(server.origin, briefingConversationPath('conversa-sem-papel'), { message: 'Olá.', idempotencyKey: 'turn-1' });
    const designerTurn = await post(server.origin, briefingConversationPath('conversa-sem-papel'), { approverRole: 'designer', message: 'Olá.', idempotencyKey: 'turn-1' });

    expect(anonymousTurn.status).toBe(403);
    expect(designerTurn.status).toBe(403);
    // No turn was bought and no key was spent: the chat is untouched, and the
    // captain still opens it with the same key.
    const untouched = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-sem-papel')}`, { headers: { origin: STUDIO_ORIGIN } }));
    expect(untouched.state).toBe('entry');
    expect(untouched.messages).toEqual([]);
    await post(server.origin, briefingConversationPath('conversa-sem-papel'), { approverRole: 'captain', idempotencyKey: 'turn-1' });
    const cancelled = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-sem-papel'), { approverRole: 'captain', action: 'cancel', idempotencyKey: 'cancel-1' }));
    expect(cancelled.state).toBe('cancelled');

    const anonymousReopen = await post(server.origin, briefingConversationReopenPath('conversa-sem-papel'), { idempotencyKey: 'reopen-1' });

    expect(anonymousReopen.status).toBe(403);
    const stillClosed = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-sem-papel')}`, { headers: { origin: STUDIO_ORIGIN } }));
    expect(stillClosed.state).toBe('cancelled');
    expect(stillClosed.previousRevisions).toEqual([]);
    expect((await post(server.origin, briefingConversationReopenPath('conversa-sem-papel'), { approverRole: 'captain', idempotencyKey: 'reopen-1' })).status).toBe(200);
  });

  it('never duplicates a turn when the same idempotency key is retried', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-idempotente', FIRST_TEXT);

    const first = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-idempotente'), { approverRole: 'captain', idempotencyKey: 'retry' }));
    const second = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-idempotente'), { approverRole: 'captain', idempotencyKey: 'retry' }));

    expect(second.messages).toHaveLength(first.messages.length);
    expect(second.messages).toEqual(first.messages);
  });

  it('refuses a body without an idempotency key, an empty message or an oversized one', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-invalida', FIRST_TEXT);

    const missingKey = await post(server.origin, briefingConversationPath('conversa-invalida'), { approverRole: 'captain', message: 'Olá.' });
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json() as { error: string }).error).toContain('idempotencyKey');

    const tooLong = await post(server.origin, briefingConversationPath('conversa-invalida'), { approverRole: 'captain', message: 'x'.repeat(IDENTITY_BRIEFING_MAX_LENGTH + 1), idempotencyKey: 'k' });
    expect(tooLong.status).toBe(400);

    await post(server.origin, briefingConversationPath('conversa-invalida'), { approverRole: 'captain', idempotencyKey: 'turn-1' });
    const empty = await post(server.origin, briefingConversationPath('conversa-invalida'), { approverRole: 'captain', message: '   ', idempotencyKey: 'k2' });
    expect(empty.status).toBe(400);
    expect((await empty.json() as { error: string }).error).toContain('não pode estar vazia');

    const unknownField = await post(server.origin, briefingConversationPath('conversa-invalida'), { approverRole: 'captain', message: 'Olá.', idempotencyKey: 'k3', preview: true });
    expect(unknownField.status).toBe(400);
  });

  it('stops the conversation on cancel and keeps the execution reopenable', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-cancelada', FIRST_TEXT);
    await post(server.origin, briefingConversationPath('conversa-cancelada'), { approverRole: 'captain', idempotencyKey: 'turn-1' });

    const cancelled = await snapshotOf(await post(server.origin, briefingConversationPath('conversa-cancelada'), { approverRole: 'captain', action: 'cancel', idempotencyKey: 'cancel-1' }));
    expect(cancelled.state).toBe('cancelled');

    const refused = await post(server.origin, briefingConversationPath('conversa-cancelada'), { approverRole: 'captain', message: 'Mais uma coisa.', idempotencyKey: 'turn-2' });
    expect(refused.status).toBe(409);

    const run = await fetch(`${server.origin}/api/identity/runs/conversa-cancelada`, { headers: { origin: STUDIO_ORIGIN } });
    expect(run.status).toBe(200);
  });

  it('spends no turn on an execution the captain stopped', async () => {
    const server = await conversationServer();
    await createRun(server.origin, 'conversa-parada', FIRST_TEXT);
    await post(server.origin, briefingConversationPath('conversa-parada'), { approverRole: 'captain', idempotencyKey: 'turn-1' });
    const stopped = await post(server.origin, '/api/identity/runs/conversa-parada/cancel', { approverRole: 'captain' });
    expect(stopped.status).toBe(200);

    const refused = await post(server.origin, briefingConversationPath('conversa-parada'), { approverRole: 'captain', message: 'Mais uma coisa.', idempotencyKey: 'turn-2' });

    expect(refused.status).toBe(409);
    const conversation = await snapshotOf(await fetch(`${server.origin}${briefingConversationPath('conversa-parada')}`, { headers: { origin: STUDIO_ORIGIN } }));
    expect(conversation.messages).toHaveLength(2);
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
    await post(server.origin, briefingConversationPath('conversa-sem-preview'), { approverRole: 'captain', idempotencyKey: 'turn-1' });
    await post(server.origin, briefingConversationPath('conversa-sem-preview'), { approverRole: 'captain', message: 'A prevenção é o centro.', idempotencyKey: 'turn-2' });
    await post(server.origin, briefingConversationPath('conversa-sem-preview'), { approverRole: 'captain', message: 'Segurança clínica com carinho.', idempotencyKey: 'turn-3' });
    await post(server.origin, briefingConversationPath('conversa-sem-preview'), { approverRole: 'captain', message: 'Acompanhamento é a promessa.', idempotencyKey: 'turn-4' });
    await post(server.origin, briefingConversationConfirmPath('conversa-sem-preview'), { approverRole: 'captain', briefing: 'Clínica de bairro preventiva.', idempotencyKey: 'confirm-1' });

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
    await post(first.origin, briefingConversationPath('conversa-reinicio'), { approverRole: 'captain', idempotencyKey: 'turn-1' });
    const before = await snapshotOf(await post(first.origin, briefingConversationPath('conversa-reinicio'), { approverRole: 'captain', message: 'A prevenção é o centro.', idempotencyKey: 'turn-2' }));
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
    const response = await post(second.origin, briefingConversationPath('conversa-sem-turno'), { approverRole: 'captain', idempotencyKey: 'turn-1' });
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
    const before = await snapshotOf(await post(first.origin, briefingConversationPath('conversa-chave'), { approverRole: 'captain', idempotencyKey: 'survives-restart' }));
    await first.close();

    const second = await conversationServer(directory);
    const retried = await snapshotOf(await post(second.origin, briefingConversationPath('conversa-chave'), { approverRole: 'captain', idempotencyKey: 'survives-restart' }));

    expect(retried.messages).toEqual(before.messages);
  });

  it('restores a confirmed briefing as a stable record a restart cannot rewrite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-conversation-restart-confirm-'));
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); });
    const first = await conversationServer(directory);
    await createRun(first.origin, 'conversa-confirmada', FIRST_TEXT);
    await post(first.origin, briefingConversationPath('conversa-confirmada'), { approverRole: 'captain', idempotencyKey: 'turn-1' });
    await post(first.origin, briefingConversationPath('conversa-confirmada'), { approverRole: 'captain', message: 'A prevenção é o centro.', idempotencyKey: 'turn-2' });
    await post(first.origin, briefingConversationPath('conversa-confirmada'), { approverRole: 'captain', message: 'Segurança clínica com carinho.', idempotencyKey: 'turn-3' });
    await post(first.origin, briefingConversationPath('conversa-confirmada'), { approverRole: 'captain', message: 'Acompanhamento é a promessa.', idempotencyKey: 'turn-4' });
    await post(first.origin, briefingConversationConfirmPath('conversa-confirmada'), { approverRole: 'captain', briefing: 'Primeira versão confirmada.', idempotencyKey: 'confirm-1' });
    await first.close();

    const second = await conversationServer(directory);
    const revised = await snapshotOf(await post(second.origin, briefingConversationConfirmPath('conversa-confirmada'), { approverRole: 'captain', briefing: 'Segunda versão, corrigida depois do restart.', idempotencyKey: 'confirm-2' }));

    expect(revised.confirmations.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(revised.confirmations[0]?.briefing).toContain('Primeira versão confirmada.');
    expect(revised.confirmations[1]?.briefing).toContain('Segunda versão, corrigida depois do restart.');
    expect(revised.briefing).toContain('Segunda versão, corrigida depois do restart.');
  });
});
