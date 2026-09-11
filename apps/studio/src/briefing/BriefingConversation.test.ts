import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RequestError } from '../request.js';
import BriefingConversation from './BriefingConversation.js';
import { ConversationContractError, type ConversationSnapshot } from './contract.js';
import { clarifyingQuestion, CONSOLIDATED_SUMMARY, conceptualDirections, confirmationTurn, conversationSnapshot, entryTurn, questionTurn, recommendationTurn } from './conversation-fixture.js';
import { classifyFailure, conversationReducer, initialConversationState, type ConversationAction, type ConversationUiState } from './machine.js';

const NOW = new Date('2026-09-11T10:00:00.000Z');
/** Copy that belongs to the visual stage; the chat must never say it. */
const VISUAL_STAGE_COPY = ['ver proposta', 'gerar identidade', 'abrir preview'];

function state(snapshot: ConversationSnapshot | null, ...actions: ConversationAction[]): ConversationUiState {
  return actions.reduce(conversationReducer, conversationReducer(initialConversationState('identity-conversation-fixture'), { type: 'resumed', snapshot }));
}

function render(next: ConversationUiState): string {
  return renderToStaticMarkup(createElement(BriefingConversation, {
    state: next,
    now: NOW,
    onDraftChange: () => undefined,
    onSummaryChange: () => undefined,
    onSendEntry: () => undefined,
    onAnswer: () => undefined,
    onSkip: () => undefined,
    onCancel: () => undefined,
    onConfirm: () => undefined,
    onRetry: () => undefined,
    onResume: () => undefined,
    onCorrect: () => undefined,
  }));
}

describe('briefing conversation panel', () => {
  it('asks for the initial text and counts it against the contract limit', () => {
    const markup = render(state(conversationSnapshot(), { type: 'draft', value: 'Somos uma clínica.' }));

    expect(markup).toContain('Conte sobre o negócio');
    expect(markup).toContain('id="briefing-chat-entry"');
    expect(markup).toContain('maxLength="8000"');
    expect(markup).toContain('18/8000 caracteres');
    expect(markup).toContain('0/6 mensagens');
    expect(markup).toContain('Enviar para leitura');
  });

  it('takes the counter and the ceiling from the snapshot, not from a constant in the interface', () => {
    const markup = render(state(conversationSnapshot({ messageCount: 3, limits: { messageLimit: 11, briefingMaxLength: 2400 } })));

    expect(markup).toContain('3/11 mensagens');
    expect(markup).toContain('maxLength="2400"');
    expect(markup).not.toContain('/6 mensagens');
  });

  it('shows the first reading with fact, hypothesis and unknown kept apart', () => {
    const markup = render(state(conversationSnapshot({ state: 'recommendation', turns: [entryTurn('Somos uma clínica de bairro.'), recommendationTurn()], messageCount: 1 })));

    expect(markup).toContain('Fatos que você disse');
    expect(markup).toContain('Hipóteses do Studio');
    expect(markup).toContain('Ainda desconhecido');
    expect(markup).toContain('A prevenção é o serviço central.');
    expect(markup).toContain('Qual é o receio que impede a primeira visita.');
  });

  it('asks one question at a time, says why it matters and offers its options', () => {
    const markup = render(state(conversationSnapshot({ state: 'question', turns: [entryTurn('Somos uma clínica de bairro.'), recommendationTurn(), questionTurn()], question: clarifyingQuestion(), messageCount: 2 })));

    expect(markup.match(/id="briefing-chat-question"/g)).toHaveLength(1);
    expect(markup).toContain('Por que isso muda a identidade.');
    expect(markup).toContain('Respostas sugeridas');
    expect(markup).toContain('Experiência premium');
    expect(markup).toContain('Pular esta pergunta');
    expect(markup).toContain('Cancelar conversa');
  });

  it('keeps the history readable and each captain turn correctable', () => {
    const markup = render(state(conversationSnapshot({ state: 'question', turns: [entryTurn('Somos uma clínica de bairro.'), recommendationTurn(), questionTurn()], question: clarifyingQuestion(), messageCount: 2 })));

    expect(markup).toContain('role="log"');
    expect(markup).toContain('aria-label="Histórico da conversa de briefing"');
    expect(markup).toContain('Somos uma clínica de bairro.');
    expect(markup.match(/Corrigir esta resposta/g)).toHaveLength(1);
  });

  it('keeps the history while a send is in flight, names the step and disables a second send', () => {
    const sending = state(conversationSnapshot({ turns: [entryTurn('Somos uma clínica de bairro.')] }), { type: 'draft', value: 'Somos uma clínica de bairro.' }, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-entry', intent: 'entry', message: 'Somos uma clínica de bairro.' } } });
    const markup = render(sending);

    expect(markup).toContain('Lendo o texto do briefing…');
    expect(markup).toContain('chat-pending');
    expect(markup).toContain('Somos uma clínica de bairro.');
    expect(markup).toContain('<button class="primary" disabled="">Enviar para leitura</button>');
  });

  it('explains a network failure, keeps the draft and offers to try again', () => {
    const failed = state(conversationSnapshot(), { type: 'draft', value: 'Somos uma clínica de bairro.' }, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-entry', intent: 'entry', message: 'Somos uma clínica de bairro.' } } }, { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) });
    const markup = render(failed);

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Nada foi fechado');
    expect(markup).toContain('Tentar novamente');
    expect(markup).toContain('>Somos uma clínica de bairro.</textarea>');
  });

  it('explains an off-contract response and offers another attempt', () => {
    const markup = render(state(conversationSnapshot(), { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'k', intent: 'entry', message: 'texto' } } }, { type: 'failed', failure: classifyFailure(new ConversationContractError('turns')) }));

    expect(markup).toContain('não seguiu o contrato');
    expect(markup).toContain('resumo editável');
    expect(markup).toContain('Tentar novamente');
  });

  it('shows the editable summary and closes the briefing with the plan’s wording', () => {
    const markup = render(state(conversationSnapshot({ state: 'confirmation', turns: [confirmationTurn()], summary: CONSOLIDATED_SUMMARY, messageCount: 3 })));

    expect(markup).toContain('id="briefing-chat-summary"');
    expect(markup).toContain(CONSOLIDATED_SUMMARY);
    expect(markup).toContain('Fechar briefing');
  });

  it('offers the editable summary and a manual close once the ceiling is reached', () => {
    const markup = render(state(conversationSnapshot({ state: 'question', question: clarifyingQuestion(), summary: CONSOLIDATED_SUMMARY, messageCount: 6 })));

    expect(markup).toContain('limite atingido');
    expect(markup).toContain('o fechamento agora é manual');
    expect(markup).toContain('Fechar briefing');
    expect(markup).not.toContain('Pular esta pergunta');
  });

  it('says plainly that a cancelled conversation sent nothing to the curator', () => {
    const markup = render(state(conversationSnapshot({ state: 'cancelled', turns: [entryTurn('Somos uma clínica de bairro.')], messageCount: 1 })));

    expect(markup).toContain('Nada foi enviado ao curador');
    expect(markup).not.toContain('Fechar briefing');
  });

  it('shows the three directions as text and marks each as having no preview', () => {
    const markup = render(state(conversationSnapshot({ state: 'final', summary: CONSOLIDATED_SUMMARY, closedAt: '2026-09-11T09:00:00.000Z', directions: conceptualDirections(), messageCount: 4 })));

    expect(markup).toContain('Briefing fechado');
    expect(markup).toContain('Clareza clínica');
    expect(markup.match(/conceito descrito · sem preview/g)).toHaveLength(3);
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('<img');
  });

  it.each([
    ['entry', conversationSnapshot()],
    ['question', conversationSnapshot({ state: 'question', question: clarifyingQuestion(), messageCount: 2 })],
    ['confirmation', conversationSnapshot({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY, messageCount: 3 })],
    ['final', conversationSnapshot({ state: 'final', summary: CONSOLIDATED_SUMMARY, closedAt: '2026-09-11T09:00:00.000Z', directions: conceptualDirections(), messageCount: 4 })],
  ])('never borrows the visual stage copy in the %s state', (_label, snapshot) => {
    const markup = render(state(snapshot)).toLowerCase();

    for (const forbidden of VISUAL_STAGE_COPY) expect(markup).not.toContain(forbidden);
  });

  it('renders nothing for a run whose conversation the server does not know', () => {
    expect(render(state(null))).toBe('');
  });
});
