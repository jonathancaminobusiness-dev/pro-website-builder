import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BRIEFING_CONVERSATION_MAX_QUESTIONS, BRIEFING_SUMMARY_MAX_LENGTH, type BriefingConversationSnapshot } from '@pwb/domain/conversation';
import { RequestError } from '../request.js';
import BriefingConversation from './BriefingConversation.js';
import { ConversationContractError, type ConversationSnapshot } from './contract.js';
import {
  afterFirstReading,
  clarifyingQuestion,
  conceptualDirections,
  confirmationTurn,
  CONSOLIDATED_SUMMARY,
  conversationSnapshot,
  FIRST_TEXT,
  followUpQuestion,
  message,
  questionTurn,
  withOpenQuestion,
} from './conversation-fixture.js';
import { classifyFailure, conversationReducer, initialConversationState, type ConversationAction, type ConversationUiState } from './machine.js';

/** Copy that belongs to the visual stage; the chat must never say it. */
const VISUAL_STAGE_COPY = ['ver proposta', 'gerar identidade', 'abrir preview'];
const LIMIT = BRIEFING_CONVERSATION_MAX_QUESTIONS;
const MAX_LENGTH = BRIEFING_SUMMARY_MAX_LENGTH;

const closedBriefing = { revision: 1, briefing: CONSOLIDATED_SUMMARY, openGaps: [], confirmedAt: '2026-09-11T09:00:00.000Z', messageCount: 5 };

function state(snapshot: ConversationSnapshot | null, ...actions: ConversationAction[]): ConversationUiState {
  const opened = snapshot === null
    ? conversationReducer(initialConversationState(), { type: 'resumed', snapshot: null })
    : conversationReducer(initialConversationState(), { type: 'settled', snapshot });
  return actions.reduce(conversationReducer, opened);
}

/** The rendered history, one entry per turn, so a control can be attributed to the turn that owns it. */
function turnBlocks(markup: string): string[] {
  return markup.split('<li class="chat-turn').slice(1);
}

/** An answer already given to the open question, so a correction has something to load. */
function answered(): BriefingConversationSnapshot['messages'] {
  return [...withOpenQuestion(), message(3, { author: 'captain', text: 'Carinho no atendimento.', state: 'question' })];
}

function render(next: ConversationUiState): string {
  return renderToStaticMarkup(createElement(BriefingConversation, {
    state: next,
    onDraftChange: () => undefined,
    onSummaryChange: () => undefined,
    onSendEntry: () => undefined,
    onAnswer: () => undefined,
    onSkip: () => undefined,
    onCancel: () => undefined,
    onConfirm: () => undefined,
    onRetry: () => undefined,
    onDiscard: () => undefined,
    onResume: () => undefined,
    onCorrect: () => undefined,
  }));
}

describe('briefing conversation panel', () => {
  it('asks for the initial text and counts it against the contract limit', () => {
    const markup = render(state(conversationSnapshot(), { type: 'draft', value: 'Somos uma clínica.' }));

    expect(markup).toContain('Conte sobre o negócio');
    expect(markup).toContain('id="briefing-chat-entry"');
    expect(markup).toContain(`maxLength="${MAX_LENGTH}"`);
    expect(markup).toContain(`18/${MAX_LENGTH} caracteres`);
    expect(markup).toContain(`0/${LIMIT} perguntas`);
    expect(markup).toContain('Enviar para leitura');
  });

  it('takes the counter and the ceiling from the contract, not from a constant in the interface', () => {
    const markup = render(state(conversationSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 3 })));

    expect(markup).toContain(`3/${LIMIT} perguntas`);
    expect(markup).toContain(`maxLength="${MAX_LENGTH}"`);
  });

  it('shows the first reading with fact, hypothesis and unknown kept apart', () => {
    const markup = render(state(conversationSnapshot({ state: 'recommendation', originalText: FIRST_TEXT, messages: afterFirstReading() })));

    expect(markup).toContain('Fatos que você disse');
    expect(markup).toContain('Hipóteses do Studio');
    expect(markup).toContain('Ainda desconhecido');
    expect(markup).toContain('A prevenção é o serviço central.');
    expect(markup).toContain('Qual é o receio que impede a primeira visita.');
    // A gap is read with what it would change, which is the reason it is asked.
    expect(markup).toContain('Decide o que a marca precisa desarmar logo na primeira tela.');
  });

  it('asks one question at a time, says why it matters and offers its options', () => {
    const markup = render(state(conversationSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 1 })));

    expect(markup.match(/id="briefing-chat-question"/g)).toHaveLength(1);
    expect(markup).toContain('Por que isso muda a identidade.');
    expect(markup).toContain('Respostas sugeridas');
    expect(markup).toContain('Experiência premium');
    expect(markup).toContain('Pular esta pergunta');
    expect(markup).toContain('Cancelar conversa');
  });

  it('keeps the history readable and corrects only the turn the open field holds', () => {
    const markup = render(state(conversationSnapshot({ state: 'question', originalText: FIRST_TEXT, messages: answered(), questionCount: 1 })));

    expect(markup).toContain('role="log"');
    expect(markup).toContain('aria-label="Histórico da conversa de briefing"');
    expect(markup).toContain(FIRST_TEXT);
    // One control, and it belongs to the answer the question field holds: the
    // entry text is not correctable here, so a correction can never post the
    // business description as the answer to the open question.
    expect(markup.match(/Corrigir esta resposta/g)).toHaveLength(1);
    const withControl = turnBlocks(markup).filter((block) => block.includes('Corrigir esta resposta'));
    expect(withControl).toHaveLength(1);
    expect(withControl[0]).toContain('Carinho no atendimento.');
    expect(withControl[0]).not.toContain(FIRST_TEXT);
  });

  it('offers no correction of an answer the conversation has already moved past', () => {
    const follow = questionTurn(followUpQuestion());
    const markup = render(state(conversationSnapshot({
      state: 'question',
      originalText: FIRST_TEXT,
      messages: [...answered(), message(4, { author: 'studio', text: follow.message, state: 'question', turn: follow })],
      questionCount: 2,
    })));

    expect(markup).toContain('Qual prova de acompanhamento');
    expect(markup).not.toContain('Corrigir esta resposta');
  });

  it('offers no correction over an open question the captain has not answered yet', () => {
    const markup = render(state(conversationSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 1 })));

    expect(markup).toContain('id="briefing-chat-answer"');
    expect(markup).not.toContain('Corrigir esta resposta');
  });

  it('corrects the last text the composer sent while the composer is the field on screen', () => {
    const markup = render(state(conversationSnapshot({ state: 'recommendation', originalText: FIRST_TEXT, messages: afterFirstReading() })));

    const withControl = turnBlocks(markup).filter((block) => block.includes('Corrigir esta resposta'));
    expect(withControl).toHaveLength(1);
    expect(withControl[0]).toContain(FIRST_TEXT);
  });

  it('keeps the history while a send is in flight, names the step and disables a second send', () => {
    const sending = state(conversationSnapshot({ messages: [message(0, { author: 'captain', text: FIRST_TEXT, state: 'entry' })] }), { type: 'draft', value: FIRST_TEXT }, { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-entry', intent: 'entry', message: FIRST_TEXT } } });
    const markup = render(sending);

    expect(markup).toContain('Lendo o texto do briefing…');
    expect(markup).toContain('chat-pending');
    expect(markup).toContain(FIRST_TEXT);
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
    const markup = render(state(conversationSnapshot(), { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'k', intent: 'entry', message: 'texto' } } }, { type: 'failed', failure: classifyFailure(new ConversationContractError('messages')) }));

    expect(markup).toContain('não seguiu o contrato');
    expect(markup).toContain('Tente novamente.');
    expect(markup).toContain('Tentar novamente');
  });

  it('offers a way out of a cancel that failed over a briefing the captain had typed', () => {
    const markup = render(state(
      conversationSnapshot(),
      { type: 'draft', value: 'Somos uma clínica veterinária de bairro.' },
      { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-cancel', intent: 'cancel', message: '' } } },
      { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) },
    ));

    expect(markup).toContain('o que você escreveu continua aqui');
    expect(markup).toContain('Dispensar aviso');
    expect(markup).not.toContain('Tentar novamente');
    expect(markup).toContain('id="briefing-chat-entry"');
    expect(markup).not.toContain('readOnly=""');
  });

  it('never leaves a failure with words but no action, and names only the action it renders', () => {
    const markup = render(state(
      conversationSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 1 }),
      { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-skip', intent: 'skip', message: '' } } },
      { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) },
      { type: 'draft', value: 'Segurança clínica.' },
    ));

    expect(markup).toContain('Nada foi fechado');
    expect(markup).not.toContain('Tentar novamente');
    expect(markup).not.toContain('Tente novamente.');
    expect(markup).toContain('Dispensar aviso');
    expect(markup).not.toContain('Você · enviando');
  });

  it('shows the editable summary and closes the briefing with the plan’s wording', () => {
    const confirmation = confirmationTurn();
    const markup = render(state(conversationSnapshot({ state: 'confirmation', messages: [message(0, { author: 'studio', text: confirmation.message, state: 'confirmation', turn: confirmation })], summary: CONSOLIDATED_SUMMARY })));

    expect(markup).toContain('id="briefing-chat-summary"');
    expect(markup).toContain(CONSOLIDATED_SUMMARY);
    expect(markup).toContain('Fechar briefing');
  });

  it('offers the editable summary and a manual close once the ceiling is reached', () => {
    const markup = render(state(conversationSnapshot({ state: 'confirmation', messages: withOpenQuestion(), summary: CONSOLIDATED_SUMMARY, questionCount: LIMIT, limitReached: true })));

    expect(markup).toContain('limite atingido');
    expect(markup).toContain('o fechamento agora é manual');
    expect(markup).toContain('Fechar briefing');
    expect(markup).not.toContain('Pular esta pergunta');
  });

  it('offers an exit from a state that shows no composer at all', () => {
    const markup = render(state(conversationSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 1 })));

    expect(markup).toContain('Cancelar conversa');
    expect(markup).not.toContain('disabled="">Cancelar conversa');
  });

  it('reopens the question after a failed skip, which took no field with it', () => {
    const markup = render(state(
      conversationSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 1 }),
      { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-skip', intent: 'skip', message: '' } } },
      { type: 'failed', failure: classifyFailure(new ConversationContractError('messages')) },
    ));

    expect(markup).toContain('não seguiu o contrato');
    expect(markup).toContain('Tentar novamente');
    expect(markup).not.toContain('Editar e reenviar');
    expect(markup).not.toContain('disabled="">Pular esta pergunta');
    expect(markup).not.toContain('disabled="">Cancelar conversa');
    expect(markup).not.toContain('readOnly=""');
  });

  it('offers a conversation the model could not finish the close it can still do, and no cancel it cannot', () => {
    const markup = render(state(conversationSnapshot({ state: 'failed', originalText: FIRST_TEXT, messages: afterFirstReading(), error: { code: 'CONVERSATION_NO_ANSWER', message: 'o modelo não respondeu' }, fallback: true })));

    expect(markup).toContain('A conversa parou');
    expect(markup).toContain('não continua nesta execução');
    expect(markup).not.toContain('Reabrir do ponto salvo');
    expect(markup).not.toContain('Cancelar conversa');
    expect(markup).toContain('Fechar briefing');
    expect(markup).not.toContain('disabled="">Fechar briefing');
  });

  it('offers a single way out of the conversation, wherever it stands', () => {
    for (const snapshot of [
      conversationSnapshot(),
      conversationSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 1 }),
      conversationSnapshot({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY }),
    ]) {
      expect(render(state(snapshot)).match(/Cancelar conversa/g)).toHaveLength(1);
    }
  });

  it('shows the open question without inventing an ordinal the counter cannot give', () => {
    const markup = render(state(conversationSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 1 })));

    expect(markup).toContain(`1/${LIMIT} perguntas`);
    expect(markup).not.toContain('de no máximo');
    expect(markup).not.toContain('Pergunta 3');
  });

  it('says plainly that a cancelled conversation sent nothing to the curator, and names the one way forward', () => {
    const markup = render(state(conversationSnapshot({ state: 'cancelled', originalText: FIRST_TEXT, messages: afterFirstReading() })));

    expect(markup).toContain('Nada foi enviado ao curador');
    expect(markup).toContain('não volta a abrir nesta execução');
    expect(markup).toContain('criar uma nova execução');
    expect(markup).not.toContain('Reabrir do ponto salvo');
    expect(markup).not.toContain('Cancelar conversa');
    expect(markup).not.toContain('id="briefing-chat-summary"');
    expect(markup).not.toContain('Fechar briefing');
  });

  it('never blames a ceiling for a close the captain reached without one', () => {
    const markup = render(state(conversationSnapshot({ state: 'confirmation', originalText: FIRST_TEXT, summary: CONSOLIDATED_SUMMARY })));

    expect(markup).toContain('id="briefing-chat-summary"');
    expect(markup).toContain('Corrija o que estiver errado antes de fechar.');
    expect(markup).not.toContain('limite');
  });

  it('never offers to reopen the conversation over a field the captain is editing', () => {
    const summaryVisible = render(state(conversationSnapshot({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY })));
    const answerVisible = render(state(conversationSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 1 })));

    expect(summaryVisible).toContain('id="briefing-chat-summary"');
    expect(summaryVisible).not.toContain('Reabrir do ponto salvo');
    expect(answerVisible).toContain('id="briefing-chat-answer"');
    expect(answerVisible).not.toContain('Reabrir do ponto salvo');
  });

  it('freezes the field a failed request came from and offers to edit it instead of replaying it', () => {
    const failed = state(
      conversationSnapshot({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY }),
      { type: 'begin', intent: { kind: 'confirm', request: { idempotencyKey: 'key-confirm', summary: CONSOLIDATED_SUMMARY } } },
      { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) },
    );
    const markup = render(failed);

    expect(markup).toContain('readOnly=""');
    expect(markup).toContain('Editar e reenviar');
    expect(markup).toContain('Tentar novamente');
    expect(markup).toContain('disabled="">Fechar briefing');
    expect(render(conversationReducer(failed, { type: 'discard' }))).not.toContain('readOnly=""');
  });

  it('freezes every writer of a locked field, not just the keyboard', () => {
    const failed = state(
      conversationSnapshot({ state: 'question', originalText: FIRST_TEXT, messages: answered(), questionCount: 1 }),
      { type: 'draft', value: 'Segurança clínica.' },
      { type: 'begin', intent: { kind: 'send', request: { idempotencyKey: 'key-answer', intent: 'answer', message: 'Segurança clínica.' } } },
      { type: 'failed', failure: classifyFailure(new RequestError('O servidor local não respondeu.')) },
    );
    const markup = render(failed);

    expect(markup).toContain('readOnly=""');
    expect(markup).toContain('disabled="">Experiência premium');
    expect(markup).toContain('disabled="">Corrigir esta resposta');

    const editable = render(conversationReducer(failed, { type: 'discard' }));

    expect(editable).not.toContain('disabled="">Experiência premium');
    expect(editable).not.toContain('disabled="">Corrigir esta resposta');
  });

  it('names a new execution when a ceiling arrives before any text was saved', () => {
    const markup = render(state(conversationSnapshot({ state: 'entry', questionCount: LIMIT, limitReached: true })));

    expect(markup).toContain('antes de qualquer texto ser salvo');
    expect(markup).toContain('criar uma nova execução');
    expect(markup).not.toContain('revise o resumo');
    expect(markup).not.toContain('id="briefing-chat-summary"');
    expect(markup).not.toContain('id="briefing-chat-entry"');
    expect(markup).not.toContain('Reabrir do ponto salvo');
  });

  it('keeps the ceiling wording pointed at a summary that is really there', () => {
    const markup = render(state(conversationSnapshot({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY, questionCount: LIMIT, limitReached: true })));

    expect(markup).toContain('revise o resumo');
    expect(markup).toContain('id="briefing-chat-summary"');
    expect(markup).not.toContain('criar uma nova execução');
  });

  it('names the read in flight when an unreadable conversation is being retried', () => {
    const retrying = conversationReducer(
      conversationReducer(
        conversationReducer(initialConversationState(), { type: 'begin', intent: { kind: 'resume' } }),
        { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) },
      ),
      { type: 'begin', intent: { kind: 'resume' } },
    );
    const markup = render(retrying);

    expect(markup).toContain('Reabrindo a conversa desta execução…');
    expect(markup).not.toContain('Não foi possível abrir a conversa desta execução');
  });

  it('says the conversation could not be read instead of reporting a read still running', () => {
    const unreachable = conversationReducer(
      conversationReducer(initialConversationState(), { type: 'begin', intent: { kind: 'resume' } }),
      { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) },
    );
    const markup = render(unreachable);

    expect(markup).toContain('Não foi possível abrir a conversa desta execução');
    expect(markup).not.toContain('Abrindo a conversa desta execução…');
    expect(markup.match(/Tentar novamente/g)).toHaveLength(1);
    expect(markup).not.toContain('Reabrir do ponto salvo');
  });

  it('keeps the way out of the conversation live when a read failed', () => {
    const markup = render(state(
      conversationSnapshot({ state: 'question', originalText: FIRST_TEXT, messages: withOpenQuestion(), questionCount: 1 }),
      { type: 'begin', intent: { kind: 'resume' } },
      { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) },
    ));

    expect(markup).toContain('Cancelar conversa');
    expect(markup).not.toContain('disabled="">Cancelar conversa');
    expect(markup).not.toContain('readOnly=""');
    expect(markup).toContain('Tentar novamente');
  });

  it('offers only a replay when the failed request was a read of the conversation', () => {
    const markup = render(state(
      conversationSnapshot({ state: 'recommendation', originalText: FIRST_TEXT, messages: afterFirstReading() }),
      { type: 'begin', intent: { kind: 'resume' } },
      { type: 'failed', failure: classifyFailure(new RequestError('Falha ao ler a conversa.', 500)) },
    ));

    expect(markup).toContain('Tentar novamente');
    expect(markup).not.toContain('Editar e reenviar');
  });

  it('keeps the conversation on screen when a reopen finds no conversation on the server', () => {
    const markup = render(state(
      conversationSnapshot({ state: 'recommendation', originalText: FIRST_TEXT, messages: afterFirstReading() }),
      { type: 'begin', intent: { kind: 'resume' } },
      { type: 'resumed', snapshot: null },
    ));

    expect(markup).toContain(FIRST_TEXT);
    expect(markup).toContain('não a encontrou');
    expect(markup).toContain('Tentar novamente');
    expect(markup).not.toContain('Briefing fechado');
  });

  it('stops offering the composer once a ceiling was reached', () => {
    const markup = render(state(conversationSnapshot({ state: 'confirmation', originalText: FIRST_TEXT, summary: CONSOLIDATED_SUMMARY, questionCount: LIMIT, limitReached: true })));

    expect(markup).toContain('limite atingido');
    expect(markup).not.toContain('id="briefing-chat-entry"');
    expect(markup).not.toContain('Enviar para leitura');
    expect(markup).toContain('Fechar briefing');
  });

  it('shows no question block while the conversation is not asking one', () => {
    const markup = render(state(conversationSnapshot({ state: 'recommendation', originalText: FIRST_TEXT, messages: withOpenQuestion(), questionCount: 1 })));

    expect(markup).not.toContain('id="briefing-chat-question"');
    expect(markup).not.toContain('Responder');
    expect(markup).not.toContain('Pular esta pergunta');
  });

  it('offers the close for a consolidated summary the server has not confirmed', () => {
    const markup = render(state(conversationSnapshot({ state: 'final', originalText: FIRST_TEXT, summary: CONSOLIDATED_SUMMARY })));

    expect(markup).toContain('id="briefing-chat-summary"');
    expect(markup).toContain(CONSOLIDATED_SUMMARY);
    expect(markup).toContain('Fechar briefing');
    expect(markup).not.toContain('disabled="">Fechar briefing');
    expect(markup).not.toContain('Briefing fechado');
  });

  it('shows the three directions as text and marks each as having no preview', () => {
    const markup = render(state(conversationSnapshot({ state: 'final', summary: CONSOLIDATED_SUMMARY, briefing: CONSOLIDATED_SUMMARY, confirmations: [closedBriefing], directions: conceptualDirections() })));

    expect(markup).toContain('Briefing fechado');
    expect(markup).toContain('Clareza clínica');
    expect(markup).toContain('Paleta descrita');
    expect(markup.match(/conceito descrito · sem preview/g)).toHaveLength(3);
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('<img');
  });

  it.each([
    ['entry', conversationSnapshot()],
    ['question', conversationSnapshot({ state: 'question', messages: withOpenQuestion(), questionCount: 1 })],
    ['confirmation', conversationSnapshot({ state: 'confirmation', summary: CONSOLIDATED_SUMMARY })],
    ['final', conversationSnapshot({ state: 'final', summary: CONSOLIDATED_SUMMARY, briefing: CONSOLIDATED_SUMMARY, confirmations: [closedBriefing], directions: conceptualDirections() })],
  ])('never borrows the visual stage copy in the %s state', (_label, snapshot) => {
    const markup = render(state(snapshot)).toLowerCase();

    for (const forbidden of VISUAL_STAGE_COPY) expect(markup).not.toContain(forbidden);
  });

  it('renders nothing for a run whose conversation the server does not know', () => {
    expect(render(state(null))).toBe('');
  });
});
