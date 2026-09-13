import { describe, expect, it } from 'vitest';
import { RequestError } from '../request.js';
import { createConversationClient, newIdempotencyKey } from './client.js';
import { ConversationContractError } from './contract.js';
import { afterFirstReading, CONSOLIDATED_SUMMARY, FIRST_TEXT, withOpenQuestion, wireSnapshot } from './conversation-fixture.js';

function recorder(answer: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const value = answer(url, init);
    if (value instanceof Error) throw value;
    return value as T;
  };
  return { calls, request };
}

describe('conversation client', () => {
  it('reads the persisted conversation back from the resume endpoint', async () => {
    const { calls, request } = recorder(() => wireSnapshot({ state: 'recommendation', originalText: FIRST_TEXT, normalizedText: FIRST_TEXT, messages: afterFirstReading() }));
    const snapshot = await createConversationClient('http://127.0.0.1:4310', request).resume('identity-1');

    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:4310/api/identity/runs/identity-1/conversation', method: 'GET' });
    expect(snapshot?.state).toBe('recommendation');
    expect(snapshot?.turns).toHaveLength(2);
  });

  it('reports a run the server has no conversation for as absent rather than as a failure', async () => {
    const { request } = recorder(() => new RequestError('Conversa não encontrada.', 404));

    await expect(createConversationClient('http://127.0.0.1:4310', request).resume('identity-legacy')).resolves.toBeNull();
  });

  it('lets every other refusal through so the screen can explain it', async () => {
    const { request } = recorder(() => new RequestError('Execução bloqueada.', 409));

    await expect(createConversationClient('http://127.0.0.1:4310', request).resume('identity-1')).rejects.toThrow('Execução bloqueada.');
  });

  it('posts the message as the contract\'s action, with the idempotency key the caller chose', async () => {
    const { calls, request } = recorder(() => wireSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 1 }));
    await createConversationClient('http://127.0.0.1:4310', request).send('identity-1', { idempotencyKey: 'key-answer', intent: 'answer', message: 'Segurança clínica.' });

    expect(calls[0]).toEqual({
      url: 'http://127.0.0.1:4310/api/identity/runs/identity-1/conversation',
      method: 'POST',
      body: { action: 'answer', idempotencyKey: 'key-answer', message: 'Segurança clínica.' },
    });
  });

  it('closes the briefing through the confirm endpoint with the summary as edited', async () => {
    const { calls, request } = recorder(() => wireSnapshot({
      state: 'final',
      summary: CONSOLIDATED_SUMMARY,
      confirmations: [{ revision: 1, briefing: CONSOLIDATED_SUMMARY, openGaps: [], confirmedAt: '2026-09-11T12:00:00.000Z', messageCount: 5 }],
    }));
    const snapshot = await createConversationClient('http://127.0.0.1:4310', request).confirm('identity-1', { idempotencyKey: 'key-confirm', summary: CONSOLIDATED_SUMMARY });

    expect(calls[0]).toEqual({
      url: 'http://127.0.0.1:4310/api/identity/runs/identity-1/conversation/confirm',
      method: 'POST',
      body: { briefing: CONSOLIDATED_SUMMARY, idempotencyKey: 'key-confirm' },
    });
    expect(snapshot.closed).toBe(true);
  });

  it('refuses a response that does not match the contract', async () => {
    const { request } = recorder(() => ({ state: 'entry', messages: 'nenhuma' }));

    await expect(createConversationClient('http://127.0.0.1:4310', request).send('identity-1', { idempotencyKey: 'k', intent: 'entry', message: 'texto' })).rejects.toThrow(ConversationContractError);
  });

  it('mints a distinct key per new intent', () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});
