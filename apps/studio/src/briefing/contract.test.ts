import { describe, expect, it } from 'vitest';
import {
  ConversationContractError,
  atMessageLimit,
  briefingClosed,
  conversationConfirmPath,
  conversationPath,
  limitReached,
  parseConversationSnapshot,
  pastTimeLimit,
} from './contract.js';
import { clarifyingQuestion, CONSOLIDATED_SUMMARY, conceptualDirections, confirmationTurn, conversationSnapshot, entryTurn, questionTurn } from './conversation-fixture.js';

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...conversationSnapshot(), ...overrides } as unknown as Record<string, unknown>;
}

describe('conversation contract', () => {
  it('addresses the endpoints the server slice publishes', () => {
    expect(conversationPath('identity-1')).toBe('/api/identity/runs/identity-1/conversation');
    expect(conversationConfirmPath('identity-1')).toBe('/api/identity/runs/identity-1/conversation/confirm');
  });

  it('escapes a run id that would otherwise change the path', () => {
    expect(conversationPath('a/b?c')).toBe('/api/identity/runs/a%2Fb%3Fc/conversation');
  });

  it('parses a full snapshot, keeping the turn fields the contract names', () => {
    const parsed = parseConversationSnapshot(wire({
      state: 'confirmation',
      turns: [entryTurn('Somos uma clínica de bairro.'), questionTurn(), confirmationTurn()],
      summary: CONSOLIDATED_SUMMARY,
      messageCount: 3,
      directions: conceptualDirections(),
    }));

    expect(parsed.state).toBe('confirmation');
    expect(parsed.turns.map((turn) => turn.intent)).toEqual(['entry', 'question', 'confirmation']);
    expect(parsed.turns[1]?.question?.why).toContain('trade-off');
    expect(parsed.turns[2]?.summary).toBe(CONSOLIDATED_SUMMARY);
    expect(parsed.directions).toHaveLength(3);
  });

  it('keeps the current question and its options', () => {
    const parsed = parseConversationSnapshot(wire({ state: 'question', question: clarifyingQuestion(), messageCount: 2 }));

    expect(parsed.question?.id).toBe('question-first-visit');
    expect(parsed.question?.options).toEqual(['Segurança clínica', 'Carinho no atendimento', 'Experiência premium']);
  });

  it.each([
    ['a state outside the seven', wire({ state: 'thinking' })],
    ['a missing message limit', wire({ limits: { briefingMaxLength: 8000 } })],
    ['a negative message count', wire({ messageCount: -1 })],
    ['turns that are not a list', wire({ turns: {} })],
    ['a turn with an unknown intent', wire({ turns: [{ ...entryTurn('x'), intent: 'invent' }] })],
    ['a turn whose nextState is not a state', wire({ turns: [{ ...entryTurn('x'), nextState: 'somewhere' }] })],
    ['a question with no reason', wire({ question: { id: 'q', prompt: 'p' } })],
    ['a direction that is not an object', wire({ directions: ['laço'] })],
    ['a time ceiling no clock can read', wire({ limits: { messageLimit: 6, briefingMaxLength: 8000, expiresAt: 'amanhã de manhã' } })],
    ['a summary that is not text', wire({ state: 'confirmation', summary: { text: CONSOLIDATED_SUMMARY } })],
    ['a body that is not an object', 'entry'],
  ])('refuses %s', (_label, payload) => {
    expect(() => parseConversationSnapshot(payload)).toThrow(ConversationContractError);
  });

  it('reads a conversation with no summary yet as an empty one', () => {
    expect(parseConversationSnapshot(wire({ summary: undefined })).summary).toBe('');
    expect(parseConversationSnapshot(wire({ summary: null })).summary).toBe('');
  });

  it('reads the ceiling from the snapshot rather than from a constant', () => {
    const tight = parseConversationSnapshot(wire({ messageCount: 4, limits: { messageLimit: 4, briefingMaxLength: 8000 } }));
    const roomy = parseConversationSnapshot(wire({ messageCount: 4, limits: { messageLimit: 9, briefingMaxLength: 8000 } }));

    expect(atMessageLimit(tight)).toBe(true);
    expect(atMessageLimit(roomy)).toBe(false);
  });

  it('treats a passed deadline as a reached limit and no deadline as none', () => {
    const timed = parseConversationSnapshot(wire({ limits: { messageLimit: 9, briefingMaxLength: 8000, expiresAt: '2026-09-11T12:00:00.000Z' } }));

    expect(pastTimeLimit(timed, new Date('2026-09-11T11:59:59.000Z'))).toBe(false);
    expect(pastTimeLimit(timed, new Date('2026-09-11T12:00:01.000Z'))).toBe(true);
    expect(limitReached(timed, new Date('2026-09-11T12:00:01.000Z'))).toBe(true);
    expect(pastTimeLimit(parseConversationSnapshot(wire()), new Date('2099-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('calls the briefing closed only once the server recorded the closing', () => {
    expect(briefingClosed(parseConversationSnapshot(wire({ state: 'final' })))).toBe(false);
    expect(briefingClosed(parseConversationSnapshot(wire({ state: 'final', closedAt: '2026-09-11T12:00:00.000Z' })))).toBe(true);
  });
});
