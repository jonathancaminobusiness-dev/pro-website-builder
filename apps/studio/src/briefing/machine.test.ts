import { describe, expect, it } from 'vitest';
import { BRIEFING_CONVERSATION_MAX_QUESTIONS, type BriefingConversationSnapshot } from '@pwb/domain/conversation';
import { RequestError } from '../request.js';
import { ConversationContractError } from './contract.js';
import {
  afterFirstReading,
  clarifyingQuestion,
  confirmationTurn,
  CONSOLIDATED_SUMMARY,
  conversationSnapshot,
  FIRST_TEXT,
  followUpQuestion,
  message,
  questionTurn,
  withOpenQuestion,
} from './conversation-fixture.js';
import {
  affordances,
  classifyFailure,
  correctableTurnId,
  conversationReducer,
  initialConversationState,
  pendingMessage,
  progressLabel,
  type ConversationAction,
  type ConversationUiState,
} from './machine.js';

function reduce(state: ConversationUiState, ...actions: ConversationAction[]): ConversationUiState {
  return actions.reduce(conversationReducer, state);
}

function opened(overrides: Partial<BriefingConversationSnapshot> = {}): ConversationUiState {
  return reduce(initialConversationState(), { type: 'begin', intent: { kind: 'resume' } }, { type: 'settled', snapshot: conversationSnapshot(overrides) });
}

/** A conversation with one question open, which is the state most of these cases are about. */
function asking(overrides: Partial<BriefingConversationSnapshot> = {}): ConversationUiState {
  return opened({ state: 'question', originalText: FIRST_TEXT, messages: withOpenQuestion(), questionCount: 1, ...overrides });
}

/** The transcript of an answer already given to the open question, so a correction has something to load. */
function answered(): BriefingConversationSnapshot['messages'] {
  return [...withOpenQuestion(), message(3, { author: 'captain', text: 'Carinho no atendimento.', state: 'question' })];
}

const entryIntent = { kind: 'send', request: { idempotencyKey: 'key-entry', intent: 'entry', message: 'Somos uma clínica veterinária de bairro.' } } as const;
const skipIntent = { kind: 'send', request: { idempotencyKey: 'key-skip', intent: 'skip', message: '' } } as const;

describe('conversation ui state', () => {
  it('opens a run at the point the server persisted, never at a default', () => {
    const state = asking();

    expect(state.availability).toBe('available');
    expect(state.snapshot?.state).toBe('question');
    expect(state.snapshot?.turns).toHaveLength(3);
  });

  it('marks a run the server has no conversation for as absent, leaving the old flow alone', () => {
    const state = reduce(initialConversationState(), { type: 'resumed', snapshot: null });

    expect(state.availability).toBe('absent');
    expect(state.snapshot).toBeNull();
    expect(affordances(state).ready).toBe(false);
  });

  it('treats a 404 after a conversation was read as a failed read, keeping the history and the gate closed', () => {
    const read = opened({ state: 'recommendation', originalText: FIRST_TEXT, messages: afterFirstReading() });
    const state = reduce(read, { type: 'begin', intent: { kind: 'resume' } }, { type: 'resumed', snapshot: null });
    const can = affordances(state);

    expect(state.availability).toBe('available');
    expect(state.snapshot?.turns).toHaveLength(2);
    expect(state.failure).not.toBeNull();
    expect(can.closed).toBe(false);
    expect(can.canRetry).toBe(true);
  });

  it('leaves every exit live after a read failed, since a read holds no field back', () => {
    const read = opened({ state: 'recommendation', originalText: FIRST_TEXT, messages: afterFirstReading() });
    const lost = reduce(read, { type: 'begin', intent: { kind: 'resume' } }, { type: 'resumed', snapshot: null });
    const unreadable = reduce(read, { type: 'begin', intent: { kind: 'resume' } }, { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) });

    for (const state of [lost, unreadable]) {
      const can = affordances(state);
      expect(can.locked).toBe(false);
      expect(can.canCancel).toBe(true);
      expect(can.canRetry).toBe(true);
      expect(can.closed).toBe(false);
    }
  });

  it('unlocks the question again when a skip fails, since a skip held no field back', () => {
    const failed = reduce(asking(), { type: 'begin', intent: skipIntent }, { type: 'failed', failure: classifyFailure(new ConversationContractError('messages')) });
    const can = affordances(failed);

    expect(can.locked).toBe(false);
    expect(can.canSkip).toBe(true);
    expect(can.canCancel).toBe(true);
    expect(can.canRetry).toBe(true);
    expect(can.canDiscard).toBe(false);
  });

  it('withdraws the replay of a failed skip once the captain answers the question instead', () => {
    const failed = reduce(asking(), { type: 'begin', intent: skipIntent }, { type: 'failed', failure: classifyFailure(new ConversationContractError('messages')) });
    const typed = conversationReducer(failed, { type: 'draft', value: 'Segurança clínica.' });

    expect(affordances(failed).canRetry).toBe(true);
    expect(affordances(typed).canRetry).toBe(false);
    expect(affordances(typed).canSend).toBe(true);
    expect(affordances(conversationReducer(typed, { type: 'draft', value: '' })).canRetry).toBe(true);
  });

  it('keeps replaying a failed read while the captain types, since typing answers nothing it sent', () => {
    const failed = reduce(initialConversationState(), { type: 'begin', intent: { kind: 'resume' } }, { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) }, { type: 'draft', value: FIRST_TEXT });

    expect(affordances(failed).canRetry).toBe(true);
  });

  it('holds the field a failed answer came from until the captain decides what to do with it', () => {
    const failed = reduce(asking(), { type: 'draft', value: 'Segurança clínica.' }, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-answer', intent: 'answer', message: 'Segurança clínica.' } } }, { type: 'failed', failure: classifyFailure(new ConversationContractError('messages')) });
    const can = affordances(failed);

    expect(can.locked).toBe(true);
    expect(can.canDiscard).toBe(true);
  });

  it('holds the field a failed correction came from, exactly as it holds a failed answer', () => {
    const failed = reduce(asking(), { type: 'correct', value: 'Carinho no atendimento.' }, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-correct', intent: 'correct', message: 'Carinho no atendimento.' } } }, { type: 'failed', failure: classifyFailure(new ConversationContractError('messages')) });

    expect(failed.correcting).toBe(true);
    expect(affordances(failed).locked).toBe(true);
    expect(affordances(failed).canDiscard).toBe(true);
    expect(progressLabel(conversationReducer(failed, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-correct', intent: 'correct', message: 'Carinho no atendimento.' } } }))).toBe('Registrando a correção…');
  });

  it('offers no edit-and-resend for a failed read, which carried no field', () => {
    const failed = reduce(opened({ state: 'recommendation', messages: afterFirstReading() }), { type: 'begin', intent: { kind: 'resume' } }, { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) });
    const can = affordances(failed);

    expect(can.canRetry).toBe(true);
    expect(can.canDiscard).toBe(false);
  });

  it('offers edit-and-resend for a failed send, which came from a field on screen', () => {
    const failed = reduce(opened(), { type: 'draft', value: 'Somos uma clínica veterinária de bairro.' }, { type: 'begin', intent: entryIntent }, { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) });

    expect(affordances(failed).canDiscard).toBe(true);
  });

  it('keeps the history and the draft while a send is in flight and refuses a duplicate send', () => {
    const state = reduce(opened({ messages: [message(0, { author: 'captain', text: FIRST_TEXT, state: 'entry' })] }), { type: 'draft', value: 'Somos uma clínica veterinária de bairro.' }, { type: 'begin', intent: entryIntent });

    expect(state.snapshot?.turns).toHaveLength(1);
    expect(state.draft).toBe('Somos uma clínica veterinária de bairro.');
    expect(progressLabel(state)).toBe('Lendo o texto do briefing…');
    expect(affordances(state).canSend).toBe(false);
  });

  it('preserves the draft through a network failure and offers a retry', () => {
    const state = reduce(opened(), { type: 'draft', value: 'Somos uma clínica veterinária de bairro.' }, { type: 'begin', intent: entryIntent }, { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) });

    expect(state.draft).toBe('Somos uma clínica veterinária de bairro.');
    expect(state.failure?.message).toContain('Nada foi fechado');
    expect(affordances(state).canRetry).toBe(true);
  });

  it('explains an off-contract response and does not advance the conversation', () => {
    const state = reduce(opened(), { type: 'begin', intent: entryIntent }, { type: 'failed', failure: classifyFailure(new ConversationContractError('messages')) });

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
    // The failed request is not in flight, so the log stops announcing it as
    // being sent; replaying it brings back the one bubble, never a second.
    expect(pendingMessage(failed)).toBeNull();
  });

  it('stops announcing a failed skip as being sent', () => {
    const sending = reduce(asking(), { type: 'begin', intent: skipIntent });
    const failed = conversationReducer(sending, { type: 'failed', failure: classifyFailure(new ConversationContractError('messages')) });

    expect(pendingMessage(sending)).toBe('Pular esta pergunta');
    expect(pendingMessage(failed)).toBeNull();
  });

  it('clears the answer field only when the server accepted the turn', () => {
    const sending = reduce(asking(), { type: 'draft', value: 'Segurança clínica sem perder o carinho.' }, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-answer', intent: 'answer', message: 'Segurança clínica sem perder o carinho.' } } });
    const confirmation = confirmationTurn();
    const settled = conversationReducer(sending, { type: 'settled', snapshot: conversationSnapshot({ state: 'confirmation', messages: [...answered(), message(4, { author: 'studio', text: confirmation.message, state: 'confirmation', turn: confirmation })], summary: CONSOLIDATED_SUMMARY, questionCount: 1 }) });

    expect(sending.draft).not.toBe('');
    expect(settled.draft).toBe('');
    expect(settled.summaryDraft).toBe(CONSOLIDATED_SUMMARY);
    expect(settled.pending).toBeNull();
  });

  it('leaves the next question an empty field after a skip, never the text written for the last one', () => {
    const skipping = reduce(asking(), { type: 'draft', value: 'rascunho pela metade' }, { type: 'begin', intent: skipIntent });
    const follow = questionTurn(followUpQuestion());
    const nextQuestion = conversationSnapshot({ state: 'question', messages: [...answered(), message(4, { author: 'studio', text: follow.message, state: 'question', turn: follow })], questionCount: 2 });
    const settled = conversationReducer(skipping, { type: 'settled', snapshot: nextQuestion });
    const can = affordances(settled);

    expect(pendingMessage(skipping)).toBe('Pular esta pergunta');
    expect(settled.draft).toBe('');
    expect(can.asking).toBe(true);
    expect(can.canSend).toBe(false);
  });

  it('holds an edited summary across a failed close so the retry closes what the captain wrote', () => {
    const closeIntent = { kind: 'confirm', request: { idempotencyKey: 'key-confirm', summary: 'Clínica de bairro com acompanhamento como prova.' } } as const;
    const edited = reduce(opened({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY }), { type: 'summaryDraft', value: 'Clínica de bairro com acompanhamento como prova.' }, { type: 'begin', intent: closeIntent }, { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) });

    expect(edited.summaryDraft).toBe('Clínica de bairro com acompanhamento como prova.');
    expect(edited.pending).toEqual(closeIntent);
    expect(progressLabel(conversationReducer(edited, { type: 'begin', intent: closeIntent }))).toBe('Fechando o briefing…');
  });

  it('offers the editable summary and a manual close once the question ceiling is reached', () => {
    const state = reduce(opened({ state: 'confirmation', messages: withOpenQuestion(), summary: CONSOLIDATED_SUMMARY, questionCount: BRIEFING_CONVERSATION_MAX_QUESTIONS, limitReached: true }), { type: 'summaryDraft', value: CONSOLIDATED_SUMMARY });
    const can = affordances(state);

    expect(can.atLimit).toBe(true);
    expect(can.canSend).toBe(false);
    expect(can.canSkip).toBe(false);
    expect(can.canConfirm).toBe(true);
  });

  it('stops asking for more text once a ceiling was reached', () => {
    const state = reduce(opened({ state: 'confirmation', originalText: FIRST_TEXT, summary: CONSOLIDATED_SUMMARY, questionCount: BRIEFING_CONVERSATION_MAX_QUESTIONS }), { type: 'draft', value: 'mais contexto' });
    const can = affordances(state);

    expect(can.atLimit).toBe(true);
    expect(can.composerOpen).toBe(false);
    expect(can.canSend).toBe(false);
    expect(can.canConfirm).toBe(true);
  });

  it('keeps a summary the captain edited when another request settles', () => {
    const edited = reduce(
      opened({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY }),
      { type: 'summaryDraft', value: 'Clínica de bairro com acompanhamento como prova.' },
      { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-cancel', intent: 'cancel', message: '' } } },
    );
    const settled = conversationReducer(edited, { type: 'settled', snapshot: conversationSnapshot({ state: 'failed', summary: CONSOLIDATED_SUMMARY, error: { code: 'CONVERSATION_NO_ANSWER', message: 'o modelo não respondeu' } }) });

    expect(settled.summaryDraft).toBe('Clínica de bairro com acompanhamento como prova.');
    expect(affordances(settled).canConfirm).toBe(true);
  });

  it('takes the server summary when the captain never touched the field', () => {
    const sending = reduce(asking(), { type: 'begin', intent: skipIntent });
    const settled = conversationReducer(sending, { type: 'settled', snapshot: conversationSnapshot({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY, questionCount: 1 }) });

    expect(settled.summaryDraft).toBe(CONSOLIDATED_SUMMARY);
  });

  it('locks the field a failed request came from until the captain replays or discards it', () => {
    const failed = reduce(
      opened({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY }),
      { type: 'begin', intent: { kind: 'confirm', request: { idempotencyKey: 'key-confirm', summary: CONSOLIDATED_SUMMARY } } },
      { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) },
    );
    const can = affordances(failed);

    expect(can.locked).toBe(true);
    expect(can.canConfirm).toBe(false);
    expect(can.canRetry).toBe(true);

    const discarded = conversationReducer(failed, { type: 'discard' });
    const after = affordances(discarded);

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
    expect(affordances(failed).ready).toBe(false);
    expect(affordances(failed).canRetry).toBe(true);
  });

  it('offers no empty close for a conversation that persisted no text', () => {
    const can = affordances(opened({ state: 'failed', error: { code: 'CONVERSATION_NO_ANSWER', message: 'o modelo não respondeu' } }));

    expect(can.summaryOpen).toBe(false);
    expect(can.canConfirm).toBe(false);
  });

  it('closes a consolidated summary the server left unconfirmed', () => {
    const state = opened({ state: 'final', originalText: FIRST_TEXT, summary: CONSOLIDATED_SUMMARY });
    const can = affordances(state);

    expect(can.closed).toBe(false);
    expect(state.summaryDraft).toBe(CONSOLIDATED_SUMMARY);
    expect(can.summaryOpen).toBe(true);
    expect(can.canConfirm).toBe(true);
  });

  it('closes nothing further once the briefing is closed', () => {
    const can = affordances(opened({
      state: 'final',
      summary: CONSOLIDATED_SUMMARY,
      briefing: CONSOLIDATED_SUMMARY,
      confirmations: [{ revision: 1, briefing: CONSOLIDATED_SUMMARY, openGaps: [], confirmedAt: '2026-09-11T09:00:00.000Z', messageCount: 5 }],
    }));

    expect(can.closed).toBe(true);
    expect(can.canConfirm).toBe(false);
    expect(can.canCancel).toBe(false);
  });

  it('leaves a cancelled conversation with nothing to send and nothing to close, since the contract gives it no exit', () => {
    const state = opened({ state: 'cancelled', originalText: FIRST_TEXT, messages: afterFirstReading() });
    const can = affordances(state);

    expect(can.canCancel).toBe(false);
    expect(can.composerOpen).toBe(false);
    expect(can.asking).toBe(false);
    expect(can.atLimit).toBe(false);
    expect(can.summaryOpen).toBe(false);
    expect(can.canConfirm).toBe(false);
  });

  it('keeps a conversation the model could not finish closable from its editable summary', () => {
    const state = opened({ state: 'failed', originalText: FIRST_TEXT, messages: afterFirstReading(), error: { code: 'CONVERSATION_NO_ANSWER', message: 'o modelo não respondeu' }, fallback: true });
    const can = affordances(state);

    expect(can.canCancel).toBe(false);
    expect(can.summaryOpen).toBe(true);
    expect(state.summaryDraft).toBe(FIRST_TEXT);
    expect(can.canConfirm).toBe(true);
  });

  it('calls no question open while the conversation is not asking one', () => {
    const can = affordances(opened({ state: 'recommendation', messages: withOpenQuestion(), questionCount: 1 }));

    expect(can.asking).toBe(false);
    expect(can.canSkip).toBe(false);
    expect(can.composerOpen).toBe(true);
  });

  it('starts a reopened run from nothing, so a stale draft never leaks between executions', () => {
    const previous = reduce(opened(), { type: 'draft', value: 'texto da execução anterior' });
    const reset = conversationReducer(previous, { type: 'reset' });

    expect(reset).toEqual(initialConversationState());
  });
});

describe('summary seeding', () => {
  it('falls back to the captain’s own text when a ceiling arrives before a summary', () => {
    const state = conversationReducer(initialConversationState(), { type: 'settled', snapshot: conversationSnapshot({ state: 'confirmation', originalText: FIRST_TEXT, questionCount: BRIEFING_CONVERSATION_MAX_QUESTIONS }) });

    expect(state.summaryDraft).toBe(FIRST_TEXT);
    expect(affordances(state).canConfirm).toBe(true);
  });

  it('prefers the consolidated summary whenever the server produced one', () => {
    const state = conversationReducer(initialConversationState(), { type: 'settled', snapshot: conversationSnapshot({ state: 'confirmation', originalText: FIRST_TEXT, summary: CONSOLIDATED_SUMMARY }) });

    expect(state.summaryDraft).toBe(CONSOLIDATED_SUMMARY);
  });
});

describe('correctable turn', () => {
  it('names the answer to the open question, never the entry text', () => {
    const state = opened({ state: 'question', originalText: FIRST_TEXT, messages: answered(), questionCount: 1 });

    expect(correctableTurnId(state, affordances(state))).toBe('msg-3');
  });

  it('names nothing while a question the captain never answered is the only field on screen', () => {
    const state = asking();

    expect(correctableTurnId(state, affordances(state))).toBeNull();
  });

  it('names the last text the composer sent while the composer is the field on screen', () => {
    const state = opened({ state: 'recommendation', originalText: FIRST_TEXT, messages: afterFirstReading() });

    expect(correctableTurnId(state, affordances(state))).toBe('msg-0');
  });

  it('names nothing where no field would receive the corrected text', () => {
    const state = opened({
      state: 'final',
      originalText: FIRST_TEXT,
      summary: CONSOLIDATED_SUMMARY,
      briefing: CONSOLIDATED_SUMMARY,
      messages: afterFirstReading(),
      confirmations: [{ revision: 1, briefing: CONSOLIDATED_SUMMARY, openGaps: [], confirmedAt: '2026-09-11T09:00:00.000Z', messageCount: 2 }],
    });

    expect(correctableTurnId(state, affordances(state))).toBeNull();
  });

  it('loads the corrected text back and sends it as a correction, not as a new answer', () => {
    const state = reduce(opened({ state: 'question', originalText: FIRST_TEXT, messages: answered(), questionCount: 1 }), { type: 'correct', value: 'Carinho no atendimento.' }, { type: 'draft', value: 'Carinho no atendimento, com segurança clínica.' });

    expect(state.correcting).toBe(true);
    expect(state.draft).toBe('Carinho no atendimento, com segurança clínica.');
  });
});
