import { describe, expect, it } from 'vitest';
import { RequestError } from '../request.js';
import { ConversationContractError } from './contract.js';
import { clarifyingQuestion, CONSOLIDATED_SUMMARY, answerTurn, confirmationTurn, conversationSnapshot, entryTurn, questionTurn, recommendationTurn } from './conversation-fixture.js';
import {
  affordances,
  classifyFailure,
  conversationReducer,
  initialConversationState,
  pendingMessage,
  progressLabel,
  type ConversationAction,
  type ConversationUiState,
} from './machine.js';

const NOW = new Date('2026-09-11T10:00:00.000Z');

function reduce(state: ConversationUiState, ...actions: ConversationAction[]): ConversationUiState {
  return actions.reduce(conversationReducer, state);
}

function opened(overrides = {}): ConversationUiState {
  return reduce(initialConversationState(), { type: 'begin', intent: { kind: 'resume' } }, { type: 'settled', snapshot: conversationSnapshot(overrides) });
}

const entryIntent = { kind: 'send', request: { idempotencyKey: 'key-entry', intent: 'entry', message: 'Somos uma clínica veterinária de bairro.' } } as const;

describe('conversation ui state', () => {
  it('opens a run at the point the server persisted, never at a default', () => {
    const state = opened({ state: 'question', turns: [entryTurn('Somos uma clínica de bairro.'), recommendationTurn(), questionTurn()], question: clarifyingQuestion(), messageCount: 2 });

    expect(state.availability).toBe('available');
    expect(state.snapshot?.state).toBe('question');
    expect(state.snapshot?.turns).toHaveLength(3);
  });

  it('marks a run the server has no conversation for as absent, leaving the old flow alone', () => {
    const state = reduce(initialConversationState(), { type: 'resumed', snapshot: null });

    expect(state.availability).toBe('absent');
    expect(state.snapshot).toBeNull();
    expect(affordances(state, NOW).ready).toBe(false);
  });

  it('treats a 404 after a conversation was read as a failed read, keeping the history and the gate closed', () => {
    const read = opened({ state: 'recommendation', briefing: 'Somos uma clínica de bairro.', turns: [entryTurn('Somos uma clínica de bairro.'), recommendationTurn()], messageCount: 1 });
    const state = reduce(read, { type: 'begin', intent: { kind: 'resume' } }, { type: 'resumed', snapshot: null });
    const can = affordances(state, NOW);

    expect(state.availability).toBe('available');
    expect(state.snapshot?.turns).toHaveLength(2);
    expect(state.failure).not.toBeNull();
    expect(can.closed).toBe(false);
    expect(can.canRetry).toBe(true);
  });

  it('leaves every exit live after a read failed, since a read holds no field back', () => {
    const read = opened({ state: 'recommendation', briefing: 'Somos uma clínica de bairro.', turns: [entryTurn('Somos uma clínica de bairro.'), recommendationTurn()], messageCount: 1 });
    const lost = reduce(read, { type: 'begin', intent: { kind: 'resume' } }, { type: 'resumed', snapshot: null });
    const unreadable = reduce(read, { type: 'begin', intent: { kind: 'resume' } }, { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) });

    for (const state of [lost, unreadable]) {
      const can = affordances(state, NOW);
      expect(can.locked).toBe(false);
      expect(can.canCancel).toBe(true);
      expect(can.canRetry).toBe(true);
      expect(can.closed).toBe(false);
    }
  });

  it('unlocks the question again when a skip fails, since a skip held no field back', () => {
    const asking = opened({ state: 'question', question: clarifyingQuestion(), messageCount: 2 });
    const failed = reduce(asking, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-skip', intent: 'skip', message: '' } } }, { type: 'failed', failure: classifyFailure(new ConversationContractError('turns')) });
    const can = affordances(failed, NOW);

    expect(can.locked).toBe(false);
    expect(can.canSkip).toBe(true);
    expect(can.canCancel).toBe(true);
    expect(can.canRetry).toBe(true);
    expect(can.canDiscard).toBe(false);
  });

  it('withdraws the replay of a failed skip once the captain answers the question instead', () => {
    const asking = opened({ state: 'question', question: clarifyingQuestion(), messageCount: 2 });
    const failed = reduce(asking, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-skip', intent: 'skip', message: '' } } }, { type: 'failed', failure: classifyFailure(new ConversationContractError('turns')) });
    const typed = conversationReducer(failed, { type: 'draft', value: 'Segurança clínica.' });

    expect(affordances(failed, NOW).canRetry).toBe(true);
    expect(affordances(typed, NOW).canRetry).toBe(false);
    expect(affordances(typed, NOW).canAnswer).toBe(true);
    expect(affordances(conversationReducer(typed, { type: 'draft', value: '' }), NOW).canRetry).toBe(true);
  });

  it('keeps replaying a failed read while the captain types, since typing answers nothing it sent', () => {
    const failed = reduce(initialConversationState(), { type: 'begin', intent: { kind: 'resume' } }, { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) }, { type: 'draft', value: 'Somos uma clínica de bairro.' });

    expect(affordances(failed, NOW).canRetry).toBe(true);
  });

  it('holds the field a failed answer came from until the captain decides what to do with it', () => {
    const asking = opened({ state: 'question', question: clarifyingQuestion(), messageCount: 2 });
    const failed = reduce(asking, { type: 'draft', value: 'Segurança clínica.' }, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-answer', intent: 'answer', message: 'Segurança clínica.' } } }, { type: 'failed', failure: classifyFailure(new ConversationContractError('turns')) });
    const can = affordances(failed, NOW);

    expect(can.locked).toBe(true);
    expect(can.canDiscard).toBe(true);
  });

  it('offers no edit-and-resend for a failed read, which carried no field', () => {
    const failed = reduce(opened({ state: 'recommendation', messageCount: 1 }), { type: 'begin', intent: { kind: 'resume' } }, { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) });
    const can = affordances(failed, NOW);

    expect(can.canRetry).toBe(true);
    expect(can.canDiscard).toBe(false);
  });

  it('offers edit-and-resend for a failed send, which came from a field on screen', () => {
    const failed = reduce(opened(), { type: 'draft', value: 'Somos uma clínica veterinária de bairro.' }, { type: 'begin', intent: entryIntent }, { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) });

    expect(affordances(failed, NOW).canDiscard).toBe(true);
  });

  it('keeps the history and the draft while a send is in flight and refuses a duplicate send', () => {
    const state = reduce(opened({ turns: [entryTurn('Somos uma clínica de bairro.')] }), { type: 'draft', value: 'Somos uma clínica veterinária de bairro.' }, { type: 'begin', intent: entryIntent });

    expect(state.snapshot?.turns).toHaveLength(1);
    expect(state.draft).toBe('Somos uma clínica veterinária de bairro.');
    expect(progressLabel(state)).toBe('Lendo o texto do briefing…');
    expect(affordances(state, NOW).canSendEntry).toBe(false);
  });

  it('preserves the draft through a network failure and offers a retry', () => {
    const state = reduce(opened(), { type: 'draft', value: 'Somos uma clínica veterinária de bairro.' }, { type: 'begin', intent: entryIntent }, { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) });

    expect(state.draft).toBe('Somos uma clínica veterinária de bairro.');
    expect(state.failure?.message).toContain('Nada foi fechado');
    expect(affordances(state, NOW).canRetry).toBe(true);
  });

  it('explains an off-contract response and does not advance the conversation', () => {
    const state = reduce(opened(), { type: 'begin', intent: entryIntent }, { type: 'failed', failure: classifyFailure(new ConversationContractError('turns')) });

    expect(state.failure?.message).toContain('não seguiu o contrato');
    expect(state.snapshot?.state).toBe('entry');
  });

  it('carries a refusal the server explained through as its own message', () => {
    expect(classifyFailure(new RequestError('Briefing vazio não é aceito.', 400))).toEqual({ message: 'Briefing vazio não é aceito.' });
  });

  it('retries the pending intent with the key it already had, adding no second bubble', () => {
    const failed = reduce(opened(), { type: 'draft', value: 'Somos uma clínica veterinária de bairro.' }, { type: 'begin', intent: entryIntent }, { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) });
    const retried = conversationReducer(failed, { type: 'begin', intent: entryIntent });

    expect(retried.pending).toBe(failed.pending);
    expect(retried.pending?.kind === 'send' && retried.pending.request.idempotencyKey).toBe('key-entry');
    expect(retried.failure).toBeNull();
    expect(pendingMessage(retried)).toBe('Somos uma clínica veterinária de bairro.');
    expect(pendingMessage(failed)).toBe(pendingMessage(retried));
  });

  it('clears the answer field only when the server accepted the turn', () => {
    const sending = reduce(opened({ state: 'question', question: clarifyingQuestion(), messageCount: 2 }), { type: 'draft', value: 'Segurança clínica sem perder o carinho.' }, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-answer', intent: 'answer', message: 'Segurança clínica sem perder o carinho.' } } });
    const settled = conversationReducer(sending, { type: 'settled', snapshot: conversationSnapshot({ state: 'confirmation', turns: [answerTurn('Segurança clínica sem perder o carinho.'), confirmationTurn()], summary: CONSOLIDATED_SUMMARY, messageCount: 3 }) });

    expect(sending.draft).not.toBe('');
    expect(settled.draft).toBe('');
    expect(settled.summaryDraft).toBe(CONSOLIDATED_SUMMARY);
    expect(settled.pending).toBeNull();
  });

  it('leaves the next question an empty field after a skip, never the text written for the last one', () => {
    const skipping = reduce(opened({ state: 'question', question: clarifyingQuestion() }), { type: 'draft', value: 'rascunho pela metade' }, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-skip', intent: 'skip', message: '' } } });
    const nextQuestion = conversationSnapshot({ state: 'question', question: { id: 'question-second', prompt: 'Que prova o público pede primeiro?', why: 'Ela decide o que a home mostra antes de tudo.' }, messageCount: 3 });
    const settled = conversationReducer(skipping, { type: 'settled', snapshot: nextQuestion });
    const can = affordances(settled, NOW);

    expect(pendingMessage(skipping)).toBe('Pular esta pergunta');
    expect(settled.draft).toBe('');
    expect(can.asking).toBe(true);
    expect(can.canAnswer).toBe(false);
  });

  it('holds an edited summary across a failed close so the retry closes what the captain wrote', () => {
    const closeIntent = { kind: 'confirm', request: { idempotencyKey: 'key-confirm', summary: 'Clínica de bairro com acompanhamento como prova.' } } as const;
    const edited = reduce(opened({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY, messageCount: 3 }), { type: 'summaryDraft', value: 'Clínica de bairro com acompanhamento como prova.' }, { type: 'begin', intent: closeIntent }, { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) });

    expect(edited.summaryDraft).toBe('Clínica de bairro com acompanhamento como prova.');
    expect(edited.pending).toEqual(closeIntent);
    expect(progressLabel(conversationReducer(edited, { type: 'begin', intent: closeIntent }))).toBe('Fechando o briefing…');
  });

  it('offers the editable summary and a manual close once the message ceiling is reached', () => {
    const state = reduce(opened({ state: 'question', question: clarifyingQuestion(), summary: CONSOLIDATED_SUMMARY, messageCount: 6 }), { type: 'summaryDraft', value: CONSOLIDATED_SUMMARY });
    const can = affordances(state, NOW);

    expect(can.atLimit).toBe(true);
    expect(can.canAnswer).toBe(false);
    expect(can.canSkip).toBe(false);
    expect(can.canConfirm).toBe(true);
  });

  it('stops asking for the initial text once a ceiling was reached', () => {
    const state = reduce(opened({ state: 'entry', briefing: 'Somos uma clínica veterinária de bairro.', messageCount: 6 }), { type: 'draft', value: 'Somos uma clínica veterinária de bairro.' });
    const can = affordances(state, NOW);

    expect(can.atLimit).toBe(true);
    expect(can.canSendEntry).toBe(false);
    expect(can.canConfirm).toBe(true);
  });

  it('keeps a summary the captain edited when another request settles', () => {
    const edited = reduce(
      opened({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY, messageCount: 3 }),
      { type: 'summaryDraft', value: 'Clínica de bairro com acompanhamento como prova.' },
      { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-cancel', intent: 'cancel', message: '' } } },
    );
    const settled = conversationReducer(edited, { type: 'settled', snapshot: conversationSnapshot({ state: 'cancelled', summary: CONSOLIDATED_SUMMARY, messageCount: 3 }) });

    expect(settled.summaryDraft).toBe('Clínica de bairro com acompanhamento como prova.');
    expect(affordances(settled, NOW).canConfirm).toBe(true);
  });

  it('takes the server summary when the captain never touched the field', () => {
    const sending = reduce(
      opened({ state: 'question', question: clarifyingQuestion(), messageCount: 2 }),
      { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-skip', intent: 'skip', message: '' } } },
    );
    const settled = conversationReducer(sending, { type: 'settled', snapshot: conversationSnapshot({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY, messageCount: 3 }) });

    expect(settled.summaryDraft).toBe(CONSOLIDATED_SUMMARY);
  });

  it('locks the field a failed request came from until the captain replays or discards it', () => {
    const failed = reduce(
      opened({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY, messageCount: 3 }),
      { type: 'begin', intent: { kind: 'confirm', request: { idempotencyKey: 'key-confirm', summary: CONSOLIDATED_SUMMARY } } },
      { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) },
    );
    const can = affordances(failed, NOW);

    expect(can.locked).toBe(true);
    expect(can.canConfirm).toBe(false);
    expect(can.canRetry).toBe(true);

    const discarded = conversationReducer(failed, { type: 'discard' });
    const after = affordances(discarded, NOW);

    expect(discarded.pending).toBeNull();
    expect(discarded.failure).toBeNull();
    expect(discarded.summaryDraft).toBe(CONSOLIDATED_SUMMARY);
    expect(after.locked).toBe(false);
    expect(after.canConfirm).toBe(true);
    expect(after.canRetry).toBe(false);
  });

  it('marks a conversation the server could not read as unreachable, never as absent', () => {
    const failed = reduce(
      initialConversationState(),
      { type: 'begin', intent: { kind: 'resume' } },
      { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) },
    );

    expect(failed.availability).toBe('unreachable');
    expect(affordances(failed, NOW).ready).toBe(false);
    expect(affordances(failed, NOW).canRetry).toBe(true);
  });

  it('offers no empty close for a cancelled conversation that persisted no text', () => {
    const can = affordances(opened({ state: 'cancelled', messageCount: 0 }), NOW);

    expect(can.summaryOpen).toBe(false);
    expect(can.canConfirm).toBe(false);
  });

  it('closes a consolidated summary the server left unconfirmed', () => {
    const state = opened({ state: 'final', briefing: 'texto original', summary: CONSOLIDATED_SUMMARY, messageCount: 4 });
    const can = affordances(state, NOW);

    expect(can.closed).toBe(false);
    expect(state.summaryDraft).toBe(CONSOLIDATED_SUMMARY);
    expect(can.summaryOpen).toBe(true);
    expect(can.canConfirm).toBe(true);
  });

  it('closes nothing further once the briefing is closed', () => {
    const can = affordances(opened({ state: 'final', summary: CONSOLIDATED_SUMMARY, closedAt: '2026-09-11T09:00:00.000Z', messageCount: 4 }), NOW);

    expect(can.closed).toBe(true);
    expect(can.canConfirm).toBe(false);
    expect(can.canCancel).toBe(false);
  });

  it('leaves a cancelled conversation with nothing to send, but still closable', () => {
    const state = opened({ state: 'cancelled', briefing: 'Somos uma clínica veterinária de bairro.', messageCount: 2 });
    const can = affordances(state, NOW);

    expect(can.canCancel).toBe(false);
    expect(can.canSendEntry).toBe(false);
    expect(can.asking).toBe(false);
    expect(can.atLimit).toBe(false);
    expect(can.summaryOpen).toBe(true);
    expect(state.summaryDraft).toBe('Somos uma clínica veterinária de bairro.');
    expect(can.canConfirm).toBe(true);
  });

  it('keeps a failed conversation closable from its editable summary', () => {
    const can = affordances(opened({ state: 'failed', briefing: 'Somos uma clínica veterinária de bairro.', error: 'o modelo não respondeu', messageCount: 2 }), NOW);

    expect(can.canCancel).toBe(false);
    expect(can.summaryOpen).toBe(true);
    expect(can.canConfirm).toBe(true);
  });

  it('calls no question open while the conversation is not asking one', () => {
    const can = affordances(opened({ state: 'recommendation', question: clarifyingQuestion(), messageCount: 1 }), NOW);

    expect(can.asking).toBe(false);
    expect(can.canAnswer).toBe(false);
    expect(can.canSkip).toBe(false);
  });

  it('starts a reopened run from nothing, so a stale draft never leaks between executions', () => {
    const previous = reduce(opened(), { type: 'draft', value: 'texto da execução anterior' });
    const reset = conversationReducer(previous, { type: 'reset' });

    expect(reset).toEqual(initialConversationState());
  });
});

describe('summary seeding', () => {
  it('falls back to the captain’s own text when a ceiling arrives before a summary', () => {
    const state = conversationReducer(initialConversationState(), { type: 'settled', snapshot: conversationSnapshot({ state: 'question', briefing: 'Somos uma clínica veterinária de bairro.', question: clarifyingQuestion(), messageCount: 6 }) });

    expect(state.summaryDraft).toBe('Somos uma clínica veterinária de bairro.');
    expect(affordances(state, NOW).canConfirm).toBe(true);
  });

  it('prefers the consolidated summary whenever the server produced one', () => {
    const state = conversationReducer(initialConversationState(), { type: 'settled', snapshot: conversationSnapshot({ state: 'confirmation', briefing: 'texto original', summary: CONSOLIDATED_SUMMARY, messageCount: 3 }) });

    expect(state.summaryDraft).toBe(CONSOLIDATED_SUMMARY);
  });
});
