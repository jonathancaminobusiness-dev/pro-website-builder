import { describe, expect, it } from 'vitest';
import { BRIEFING_CONVERSATION_MAX_QUESTIONS, BRIEFING_SUMMARY_MAX_LENGTH } from '@pwb/domain/conversation';
import {
  ConversationContractError,
  atQuestionLimit,
  briefingClosed,
  conversationConfirmBody,
  conversationConfirmPath,
  conversationPath,
  conversationSendBody,
  limitReached,
  parseConversationSnapshot,
} from './contract.js';
import {
  afterFirstReading,
  clarifyingQuestion,
  conceptualDirections,
  confirmationTurn,
  CONSOLIDATED_SUMMARY,
  FIRST_TEXT,
  message,
  wireSnapshot,
  withOpenQuestion,
} from './conversation-fixture.js';

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...wireSnapshot(), ...overrides } as unknown as Record<string, unknown>;
}

describe('conversation contract', () => {
  it('addresses the endpoints the shared contract publishes', () => {
    expect(conversationPath('identity-1')).toBe('/api/identity/runs/identity-1/conversation');
    expect(conversationConfirmPath('identity-1')).toBe('/api/identity/runs/identity-1/conversation/confirm');
  });

  it('escapes a run id that would otherwise change the path', () => {
    expect(conversationPath('a/b?c')).toBe('/api/identity/runs/a%2Fb%3Fc/conversation');
  });

  it('parses a full snapshot, keeping the turn fields the contract names', () => {
    const confirmation = confirmationTurn();
    const parsed = parseConversationSnapshot(wire({
      state: 'confirmation',
      originalText: FIRST_TEXT,
      normalizedText: FIRST_TEXT,
      messages: [...withOpenQuestion(), message(3, { author: 'captain', text: 'Segurança clínica.', state: 'question' }), message(4, { author: 'studio', text: confirmation.message, state: 'confirmation', turn: confirmation })],
      summary: CONSOLIDATED_SUMMARY,
      questionCount: 1,
      directions: conceptualDirections(),
    }));

    expect(parsed.state).toBe('confirmation');
    expect(parsed.turns.map((turn) => turn.role)).toEqual(['captain', 'studio', 'studio', 'captain', 'studio']);
    expect(parsed.turns.map((turn) => turn.intent)).toEqual([undefined, 'recommendation', 'question', undefined, 'confirmation']);
    expect(parsed.turns[2]?.question?.why).toContain('trade-off');
    expect(parsed.turns[4]?.summary).toBe(CONSOLIDATED_SUMMARY);
    expect(parsed.directions).toHaveLength(3);
    expect(parsed.briefing).toBe(FIRST_TEXT);
  });

  it('reads a declared gap as the line the panel lists: what is missing and what it would change', () => {
    const parsed = parseConversationSnapshot(wire({ state: 'recommendation', messages: afterFirstReading() }));

    expect(parsed.turns[1]?.unknowns).toEqual(['Qual é o receio que impede a primeira visita. — Decide o que a marca precisa desarmar logo na primeira tela.']);
  });

  it('keeps the current question and its options, named by the transcript entry that asked it', () => {
    const parsed = parseConversationSnapshot(wire({ state: 'question', messages: withOpenQuestion(), questionCount: 1 }));

    expect(parsed.question?.id).toBe('pergunta-2');
    expect(parsed.question?.prompt).toBe(clarifyingQuestion().text);
    expect(parsed.question?.options).toEqual(['Segurança clínica', 'Carinho no atendimento', 'Experiência premium']);
  });

  it('offers no open question once the conversation has moved past asking', () => {
    const parsed = parseConversationSnapshot(wire({ state: 'recommendation', messages: withOpenQuestion(), questionCount: 1 }));

    expect(parsed.question).toBeUndefined();
  });

  it.each([
    ['a state outside the seven', wire({ state: 'thinking' })],
    ['a negative question count', wire({ questionCount: -1 })],
    ['messages that are not a list', wire({ messages: {} })],
    ['a turn with an unknown intent', wire({ messages: [message(0, { author: 'studio', text: 'x', state: 'recommendation', turn: { ...confirmationTurn(), intent: 'invent' } as never })] })],
    ['a turn that narrated one move and asked for another', wire({ messages: [message(0, { author: 'studio', text: 'x', state: 'recommendation', turn: { ...confirmationTurn(), nextState: 'question' } })] })],
    ['a question with no reason', wire({ messages: [message(0, { author: 'studio', text: 'x', state: 'question', turn: { message: 'x', intent: 'question', question: { text: 'p' }, facts: [], hypotheses: [], unknowns: [], nextState: 'question' } as never })] })],
    ['a direction that is not an object', wire({ directions: ['laço'] })],
    ['a field the contract does not declare', wire({ expiresAt: '2026-09-11T12:00:00.000Z' })],
    ['a summary that is not text', wire({ state: 'confirmation', summary: { text: CONSOLIDATED_SUMMARY } })],
    ['a body that is not an object', 'entry'],
  ])('refuses %s', (_label, payload) => {
    expect(() => parseConversationSnapshot(payload)).toThrow(ConversationContractError);
  });

  it('reads a conversation with no summary yet as an empty one', () => {
    expect(parseConversationSnapshot(wire({ summary: undefined })).summary).toBe('');
  });

  it('reads the ceiling from the shared contract rather than from a constant of its own', () => {
    const tight = parseConversationSnapshot(wire({ questionCount: BRIEFING_CONVERSATION_MAX_QUESTIONS }));
    const roomy = parseConversationSnapshot(wire({ questionCount: BRIEFING_CONVERSATION_MAX_QUESTIONS - 1 }));

    expect(tight.limits.questionLimit).toBe(BRIEFING_CONVERSATION_MAX_QUESTIONS);
    expect(tight.limits.briefingMaxLength).toBe(BRIEFING_SUMMARY_MAX_LENGTH);
    expect(atQuestionLimit(tight)).toBe(true);
    expect(atQuestionLimit(roomy)).toBe(false);
    expect(limitReached(tight)).toBe(true);
    expect(limitReached(roomy)).toBe(false);
  });

  it('takes the server\'s own verdict that the conversation may no longer ask', () => {
    expect(limitReached(parseConversationSnapshot(wire({ questionCount: 1, limitReached: true })))).toBe(true);
  });

  it('calls the briefing closed only once a confirmation is on record', () => {
    expect(briefingClosed(parseConversationSnapshot(wire({ state: 'final' })))).toBe(false);
    const closed = parseConversationSnapshot(wire({
      state: 'final',
      summary: CONSOLIDATED_SUMMARY,
      confirmations: [{ revision: 1, briefing: CONSOLIDATED_SUMMARY, openGaps: [], confirmedAt: '2026-09-11T12:00:00.000Z', messageCount: 5 }],
    }));
    expect(briefingClosed(closed)).toBe(true);
  });

  it('sends the captain move as the action the contract names, and never an empty message', () => {
    expect(conversationSendBody({ idempotencyKey: 'k', intent: 'entry', message: ' texto ' })).toEqual({ action: 'answer', idempotencyKey: 'k', message: 'texto' });
    expect(conversationSendBody({ idempotencyKey: 'k', intent: 'correct', message: 'outra coisa' })).toEqual({ action: 'correct', idempotencyKey: 'k', message: 'outra coisa' });
    expect(conversationSendBody({ idempotencyKey: 'k', intent: 'skip', message: '' })).toEqual({ action: 'skip', idempotencyKey: 'k' });
    expect(conversationSendBody({ idempotencyKey: 'k', intent: 'cancel', message: '' })).toEqual({ action: 'cancel', idempotencyKey: 'k' });
  });

  it('signs the edited summary as the briefing the confirmation carries', () => {
    expect(conversationConfirmBody({ idempotencyKey: 'k', summary: CONSOLIDATED_SUMMARY })).toEqual({ briefing: CONSOLIDATED_SUMMARY, idempotencyKey: 'k' });
  });
});
