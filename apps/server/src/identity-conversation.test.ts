import { describe, expect, it } from 'vitest';
import {
  BRIEFING_CONVERSATION_MAX_QUESTIONS,
  BRIEFING_CONVERSATION_TRANSITIONS,
  briefingConversationTurnSchema,
  briefingTurnNextStates,
  canBriefingConversationTransition,
  canConfirmBriefing,
  canSendBriefingMessage,
  findVisualOutput,
  IDENTITY_BRIEFING_MAX_LENGTH,
  type AgentResult,
  type AgentTask,
  type BriefingConversationSnapshot,
  type BriefingConversationTurn,
  type ConceptualDirection,
} from '@pwb/domain';
import type { ModelProvider } from '@pwb/providers';
import { BriefingConversation, ConversationError, deterministicSummary } from './identity-conversation.js';

type Answer = AgentResult | ((task: AgentTask) => AgentResult | Promise<AgentResult>);

interface Harness {
  conversation: BriefingConversation;
  tasks: AgentTask[];
  persisted: BriefingConversationSnapshot[];
}

function turn(overrides: Partial<BriefingConversationTurn> & Pick<BriefingConversationTurn, 'intent' | 'nextState'>): Record<string, unknown> {
  return { message: 'Mensagem do Studio.', facts: [], hypotheses: [], unknowns: [], ...overrides } as unknown as Record<string, unknown>;
}

const RECOMMENDATION = turn({ intent: 'recommendation', nextState: 'recommendation', message: 'Entendi uma clínica de bairro com foco em prevenção.', facts: ['Clínica de bairro'], unknowns: [{ gap: 'Trade-off central', impact: 'Muda tom e composição.' }] });
const QUESTION = turn({ intent: 'question', nextState: 'question', message: 'Falta decidir onde a marca pousa.', question: { text: 'Segurança clínica ou carinho no atendimento?', why: 'A resposta muda o tom e a composição da identidade.', options: [] } });
const CONFIRMATION = turn({ intent: 'confirmation', nextState: 'confirmation', message: 'Dá para fechar assim?', summary: 'Clínica de bairro preventiva que equilibra autoridade clínica e proximidade.' });

function direction(id: string, label: string): ConceptualDirection {
  return { id, label, positioning: 'Posicionamento descrito em palavras.', tone: 'Tom sereno e direto.', visualLanguage: 'Gestos orgânicos com respiro largo.', palette: 'Areia como base e verde folha como cuidado.', typography: 'Serifa humana com sem-serifa de apoio.', composition: 'Blocos encadeados que leem como etapas.', applications: ['Agenda', 'Recepção'] };
}

const FINAL = turn({ intent: 'final', nextState: 'final', message: 'Briefing fechado, três direções conceituais.', summary: 'Clínica de bairro preventiva.', directions: [direction('dir-um', 'Um'), direction('dir-dois', 'Dois'), direction('dir-tres', 'Três')] });

function succeeded(artifact: Record<string, unknown>): AgentResult {
  return { taskId: 'identity-briefing-conversation-1', status: 'succeeded', summary: 'ok', artifact };
}

function harness(answers: Answer[], options: { maxQuestions?: number; initialText?: () => string | undefined; persist?: (snapshot: BriefingConversationSnapshot) => Promise<void>; onConfirmed?: (briefing: string, revision: number) => void } = {}): Harness {
  const tasks: AgentTask[] = [];
  const persisted: BriefingConversationSnapshot[] = [];
  const provider: ModelProvider = {
    async propose(task) {
      tasks.push(structuredClone(task));
      const answer = answers[tasks.length - 1];
      if (!answer) throw new Error(`No fake answer for call ${tasks.length}.`);
      return typeof answer === 'function' ? await answer(task) : answer;
    },
  };
  const conversation = new BriefingConversation({
    runId: 'run-conversa',
    provider,
    persist: async (snapshot) => { await options.persist?.(snapshot); persisted.push(snapshot); },
    now: () => new Date('2026-09-11T12:00:00.000Z'),
    newId: (() => { let n = 0; return () => `msg-${(n += 1)}`; })(),
    ...(options.maxQuestions === undefined ? {} : { maxQuestions: options.maxQuestions }),
    ...(options.initialText === undefined ? {} : { initialText: options.initialText }),
    ...(options.onConfirmed === undefined ? {} : { onConfirmed: options.onConfirmed }),
  });
  return { conversation, tasks, persisted };
}

let key = 0;
const nextKey = (): string => `key-${(key += 1)}`;

/** The moves one emitted prompt tells the model it may ask for; the prompt is the generated interface the turn delivers. */
function advertisedMoves(brief: string): string[] {
  return /pode pedir é: (.+)\./.exec(brief)?.[1]?.split(', ') ?? [];
}

describe('briefing conversation state machine', () => {
  it('opens on the captain text, normalizes its edges and answers with a first reading', async () => {
    const { conversation, tasks } = harness([succeeded(RECOMMENDATION)]);

    const snapshot = await conversation.send({ message: '  Somos uma clínica veterinária de bairro.\n', action: 'answer', idempotencyKey: nextKey() });

    expect(snapshot.state).toBe('recommendation');
    expect(snapshot.originalText).toBe('  Somos uma clínica veterinária de bairro.\n');
    expect(snapshot.normalizedText).toBe('Somos uma clínica veterinária de bairro.');
    expect(snapshot.messages.map((message) => message.author)).toEqual(['captain', 'studio']);
    expect(snapshot.messages.map((message) => message.index)).toEqual([0, 1]);
    expect(snapshot.openGaps).toEqual([{ gap: 'Trade-off central', impact: 'Muda tom e composição.' }]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.allowedPaths).toEqual([]);
  });

  it('refuses an empty or oversized message with a reason the captain can act on', async () => {
    const { conversation, tasks } = harness([]);

    await expect(conversation.send({ message: '   ', action: 'answer', idempotencyKey: nextKey() })).rejects.toThrow(/não pode estar vazia/);
    await expect(conversation.send({ message: 'x'.repeat(IDENTITY_BRIEFING_MAX_LENGTH + 1), action: 'answer', idempotencyKey: nextKey() })).rejects.toThrow(/mais de 8000 caracteres/);
    await expect(conversation.send({ message: 42 as unknown as string, action: 'answer', idempotencyKey: nextKey() })).rejects.toThrow(/deve ser um texto/);
    expect(tasks).toHaveLength(0);
  });

  it('walks entry, recommendation, question and the controlled return an answer makes', async () => {
    const { conversation, tasks } = harness([succeeded(RECOMMENDATION), succeeded(QUESTION), succeeded(RECOMMENDATION)]);

    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });
    const asked = await conversation.send({ message: 'Prevenção é o centro.', action: 'answer', idempotencyKey: nextKey() });
    expect(asked.state).toBe('question');
    expect(asked.questionCount).toBe(1);
    expect(asked.askedQuestions).toHaveLength(1);

    const answered = await conversation.send({ message: 'Segurança clínica sem perder o carinho.', action: 'answer', idempotencyKey: nextKey() });
    expect(answered.state).toBe('recommendation');
    expect(answered.askedQuestions[0]?.answer).toBe('Segurança clínica sem perder o carinho.');
    expect(answered.askedQuestions[0]?.skipped).toBe(false);
    expect(tasks).toHaveLength(3);
  });

  it('records a skipped question as skipped rather than as an answer', async () => {
    const { conversation } = harness([succeeded(RECOMMENDATION), succeeded(QUESTION), succeeded(RECOMMENDATION)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });
    await conversation.send({ message: 'Prevenção é o centro.', action: 'answer', idempotencyKey: nextKey() });

    const skipped = await conversation.send({ action: 'skip', idempotencyKey: nextKey() });

    expect(skipped.askedQuestions[0]?.skipped).toBe(true);
    expect(skipped.askedQuestions[0]?.answer).toBeUndefined();
  });

  it('refuses a skip when no question is open', async () => {
    const { conversation } = harness([succeeded(RECOMMENDATION)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    await expect(conversation.send({ action: 'skip', idempotencyKey: nextKey() })).rejects.toThrow(/pergunta aberta/);
  });

  it('refuses a model turn that asks for a move the machine does not have', async () => {
    // `entry -> question` skips the first reading the plan requires, so the
    // conversation spends its one correction and then falls back.
    const illegal = succeeded(turn({ intent: 'question', nextState: 'question', question: { text: 'Qual o público?', why: 'Define o tom.', options: [] } }));
    const { conversation, tasks } = harness([illegal, illegal]);

    const snapshot = await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    expect(tasks).toHaveLength(2);
    expect(tasks[1]?.brief).toContain('A resposta anterior foi recusada.');
    expect(snapshot.state).toBe('confirmation');
    expect(snapshot.fallback).toBe(true);
    expect(snapshot.error?.code).toBe('CONVERSATION_ILLEGAL_TRANSITION');
  });

  it('never lets a model close the briefing on its own', async () => {
    const { conversation } = harness([succeeded(FINAL), succeeded(FINAL)]);

    const snapshot = await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    expect(snapshot.state).not.toBe('final');
    expect(snapshot.directions).toEqual([]);
  });

  it('offers a correcting turn only the moves the validator accepts, never final', async () => {
    const { conversation, tasks } = harness([succeeded(CONFIRMATION), succeeded(QUESTION)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    const adjusted = await conversation.send({ message: 'Não é bem isso: o centro é a prevenção.', action: 'correct', idempotencyKey: nextKey() });

    const advertised = advertisedMoves(tasks[1]!.brief);
    expect(advertised).toEqual(briefingTurnNextStates('confirmation', { closing: false, mustConclude: false }));
    expect(advertised).not.toContain('final');
    expect(adjusted.state).toBe('question');
    expect(tasks).toHaveLength(2);
  });

  it('revises the summary when the captain corrects it after the question cap, instead of falling into safe mode', async () => {
    const revised = turn({ intent: 'confirmation', nextState: 'confirmation', message: 'Corrigido.', summary: 'Clínica de bairro preventiva, com a prevenção no centro.' });
    const { conversation, tasks } = harness([succeeded(RECOMMENDATION), succeeded(QUESTION), succeeded(CONFIRMATION), succeeded(revised)], { maxQuestions: 1 });
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });
    await conversation.send({ message: 'Prevenção é o centro.', action: 'answer', idempotencyKey: nextKey() });
    const offered = await conversation.send({ message: 'Segurança clínica sem perder o carinho.', action: 'answer', idempotencyKey: nextKey() });
    expect(offered.state).toBe('confirmation');
    expect(offered.limitReached).toBe(true);

    const adjusted = await conversation.send({ message: 'Não é bem isso: o centro é a prevenção.', action: 'correct', idempotencyKey: nextKey() });

    expect(adjusted.state).toBe('confirmation');
    expect(adjusted.fallback).toBe(false);
    expect(adjusted.summary).toBe('Clínica de bairro preventiva, com a prevenção no centro.');
    expect(tasks).toHaveLength(4);
    expect(advertisedMoves(tasks[3]!.brief)).toEqual(['confirmation']);
  });

  it('never advertises another question from the question state, where the validator refuses one', async () => {
    const { conversation, tasks } = harness([succeeded(RECOMMENDATION), succeeded(QUESTION), succeeded(RECOMMENDATION)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });
    await conversation.send({ message: 'Prevenção é o centro.', action: 'answer', idempotencyKey: nextKey() });

    const answered = await conversation.send({ message: 'Segurança clínica sem perder o carinho.', action: 'answer', idempotencyKey: nextKey() });

    expect(advertisedMoves(tasks[2]!.brief)).toEqual(briefingTurnNextStates('question', { closing: false, mustConclude: false }));
    expect(advertisedMoves(tasks[2]!.brief)).not.toContain('question');
    expect(answered.state).toBe('recommendation');
    expect(answered.fallback).toBe(false);
  });

  it('cancels without touching the execution or a briefing already confirmed', async () => {
    const { conversation, tasks } = harness([succeeded(RECOMMENDATION)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    const cancelled = await conversation.send({ action: 'cancel', idempotencyKey: nextKey() });

    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.normalizedText).toBe('Clínica veterinária de bairro.');
    expect(cancelled.messages).toHaveLength(3);
    expect(tasks).toHaveLength(1);
    await expect(conversation.send({ message: 'Mais uma coisa.', action: 'answer', idempotencyKey: nextKey() })).rejects.toThrow(/cancelada/);
  });

  it('offers an editable summary instead of a silent approval when the question limit is reached', async () => {
    const { conversation, tasks } = harness([succeeded(RECOMMENDATION), succeeded(QUESTION), succeeded(CONFIRMATION)], { maxQuestions: 1 });
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });
    await conversation.send({ message: 'Prevenção é o centro.', action: 'answer', idempotencyKey: nextKey() });

    const concluded = await conversation.send({ message: 'Segurança clínica com carinho.', action: 'answer', idempotencyKey: nextKey() });

    expect(tasks[2]?.brief).toContain('Não faça mais perguntas.');
    expect(concluded.state).toBe('confirmation');
    expect(concluded.limitReached).toBe(true);
    expect(concluded.summary).toBeTruthy();
  });

  it('rejects a question asked after the limit even if the model insists', async () => {
    const { conversation, tasks } = harness([succeeded(RECOMMENDATION), succeeded(QUESTION), succeeded(QUESTION), succeeded(QUESTION)], { maxQuestions: 1 });
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });
    await conversation.send({ message: 'Prevenção é o centro.', action: 'answer', idempotencyKey: nextKey() });

    const refused = await conversation.send({ message: 'Segurança clínica com carinho.', action: 'answer', idempotencyKey: nextKey() });

    expect(tasks).toHaveLength(4);
    expect(refused.state).toBe('confirmation');
    expect(refused.fallback).toBe(true);
    expect(refused.questionCount).toBe(1);
  });
});

describe('briefing conversation safe answers', () => {
  it('spends exactly one correction on an invalid answer and then falls back', async () => {
    const invalid: AgentResult = { taskId: 'identity-briefing-conversation-1', status: 'succeeded', summary: 'ok', artifact: { message: '', intent: 'recommendation', nextState: 'recommendation' } };
    const { conversation, tasks } = harness([invalid, invalid]);

    const snapshot = await conversation.send({ message: 'Clínica veterinária de bairro que atende cães e gatos.', action: 'answer', idempotencyKey: nextKey() });

    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.brief).not.toContain('A resposta anterior foi recusada.');
    expect(tasks[1]?.brief).toContain('A resposta anterior foi recusada.');
    expect(snapshot.attempt).toBe(2);
    expect(snapshot.state).toBe('confirmation');
    expect(snapshot.fallback).toBe(true);
    expect(snapshot.summary).toContain('Clínica veterinária de bairro que atende cães e gatos.');
    expect(snapshot.error?.message).toContain('Nada foi fechado');
  });

  it('recovers on the correction when the second answer is valid', async () => {
    const invalid: AgentResult = { taskId: 'identity-briefing-conversation-1', status: 'succeeded', summary: 'ok', artifact: { intent: 'nonsense' } };
    const { conversation, tasks } = harness([invalid, succeeded(RECOMMENDATION)]);

    const snapshot = await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    expect(tasks).toHaveLength(2);
    expect(snapshot.state).toBe('recommendation');
    expect(snapshot.fallback).toBe(false);
    expect(snapshot.error).toBeUndefined();
  });

  it('does not retry a transport failure, because the second call would fail the same way', async () => {
    const failed: AgentResult = { taskId: 'identity-briefing-conversation-1', status: 'failed', summary: 'Codex CLI não está autenticado.', errorCode: 'CODEX_AUTH_REQUIRED' };
    const { conversation, tasks } = harness([failed]);

    const snapshot = await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    expect(tasks).toHaveLength(1);
    expect(snapshot.state).toBe('confirmation');
    expect(snapshot.error?.code).toBe('CODEX_AUTH_REQUIRED');
    expect(snapshot.error?.message).toContain('Codex CLI não está autenticado.');
  });

  it('ends the conversation in safe mode when the fallback itself is not enough', async () => {
    const failed: AgentResult = { taskId: 'identity-briefing-conversation-1', status: 'failed', summary: 'O modelo caiu.', errorCode: 'CONVERSATION_PROVIDER_FAILED' };
    const { conversation } = harness([failed, failed]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    const second = await conversation.send({ message: 'Tenta de novo.', action: 'answer', idempotencyKey: nextKey() });

    expect(second.state).toBe('failed');
    expect(second.summary).toContain('Clínica veterinária de bairro.');
    expect(canConfirmBriefing(second.state)).toBe(true);
  });

  it('refuses an answer that tries to produce visual output', async () => {
    const visual = succeeded(turn({ intent: 'recommendation', nextState: 'recommendation', message: 'Proponho <section class="hero">uma home</section> com #0a7d5c.' }));
    const { conversation, tasks } = harness([visual, visual]);

    const snapshot = await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    expect(tasks[1]?.brief).toContain('Saída visual recusada');
    expect(snapshot.state).toBe('confirmation');
    expect(snapshot.fallback).toBe(true);
    expect(snapshot.messages.every((message) => !message.text.includes('<section'))).toBe(true);
  });

  it('accepts a summary that repeats a hex value and a link the captain wrote', async () => {
    const echoed = turn({ ...FINAL, summary: 'Queremos manter o verde #2E7D32 da marca atual; nosso site hoje é https://clinicax.com.br.' } as Partial<BriefingConversationTurn> & Pick<BriefingConversationTurn, 'intent' | 'nextState'>);
    const { conversation, tasks } = harness([succeeded(CONFIRMATION), succeeded(echoed)]);
    await conversation.send({ message: 'Queremos manter o verde #2E7D32 da marca atual e nosso site hoje é https://clinicax.com.br.', action: 'answer', idempotencyKey: nextKey() });

    const closed = await conversation.confirm({ briefing: 'Clínica de bairro preventiva que mantém o verde da marca atual.', idempotencyKey: nextKey() });

    expect(closed.state).toBe('final');
    expect(closed.directions).toHaveLength(3);
    expect(closed.summary).toContain('#2E7D32');
    expect(tasks).toHaveLength(2);
  });

  it('still refuses a hex value the model wrote into a conceptual direction it authored', async () => {
    const painted = turn({ ...FINAL, directions: [{ ...direction('dir-um', 'Um'), palette: 'Base areia com verde #2E7D32 nos destaques.' }, direction('dir-dois', 'Dois'), direction('dir-tres', 'Três')] } as Partial<BriefingConversationTurn> & Pick<BriefingConversationTurn, 'intent' | 'nextState'>);
    const { conversation } = harness([succeeded(CONFIRMATION), succeeded(painted), succeeded(painted)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    const closed = await conversation.confirm({ briefing: 'Clínica de bairro preventiva.', idempotencyKey: nextKey() });

    expect(closed.directions).toEqual([]);
    expect(closed.briefing).toBe('Clínica de bairro preventiva.');
    expect(closed.error?.code).toBe('CONVERSATION_VISUAL_OUTPUT');
  });

  it('refuses a hex value the model invented in hypotheses, which no captain ever wrote', async () => {
    const invented = succeeded(turn({ intent: 'recommendation', nextState: 'recommendation', hypotheses: ['A paleta natural pede algo como #2E7D32 com areia #F5EDE1.'] }));
    const { conversation, tasks } = harness([invented, invented]);

    const snapshot = await conversation.send({ message: 'Somos uma clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    expect(tasks[1]?.brief).toContain('Saída visual recusada (hex-color)');
    expect(snapshot.fallback).toBe(true);
    expect(snapshot.messages.every((message) => !message.text.includes('#2E7D32'))).toBe(true);
    expect(snapshot.messages.flatMap((message) => message.turn?.hypotheses ?? [])).toEqual([]);
  });

  it('accepts a fact that gives back an image file the captain named', async () => {
    const echoed = succeeded(turn({ intent: 'recommendation', nextState: 'recommendation', facts: ['O logo atual está em logo.png.'] }));
    const { conversation, tasks } = harness([echoed]);

    const snapshot = await conversation.send({ message: 'Nosso logo atual está no arquivo logo.png e queremos partir dele.', action: 'answer', idempotencyKey: nextKey() });

    expect(snapshot.state).toBe('recommendation');
    expect(snapshot.fallback).toBe(false);
    expect(tasks).toHaveLength(1);
  });
});

describe('briefing conversation idempotency', () => {
  it('does not buy a second turn when the same key is retried after a timeout', async () => {
    const { conversation, tasks } = harness([succeeded(RECOMMENDATION)]);
    const retried = 'retry-after-timeout';

    const first = await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: retried });
    const second = await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: retried });

    expect(tasks).toHaveLength(1);
    expect(second.messages).toHaveLength(2);
    expect(second.messages).toEqual(first.messages);
  });

  it('keeps a cancel sent during an in-flight turn, instead of letting that turn resurrect the conversation', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { conversation } = harness([async () => { await gate; return succeeded(RECOMMENDATION); }]);

    const slow = conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });
    const cancelled = conversation.send({ action: 'cancel', idempotencyKey: nextKey() });
    release();
    await slow;
    const closed = await cancelled;

    expect(closed.state).toBe('cancelled');
    expect(conversation.state).toBe('cancelled');
    expect(canSendBriefingMessage(conversation.state)).toBe(false);
    await expect(conversation.send({ message: 'Mais uma coisa.', action: 'answer', idempotencyKey: nextKey() })).rejects.toThrow(ConversationError);
  });

  it('joins an in-flight turn instead of starting a parallel one', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { conversation, tasks } = harness([async () => { await gate; return succeeded(RECOMMENDATION); }]);

    const first = conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: 'same' });
    const second = conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: 'same' });
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(tasks).toHaveLength(1);
    expect(a.messages).toEqual(b.messages);
  });
});

describe('briefing confirmation', () => {
  it('closes the briefing, records the revision and asks for three conceptual directions', async () => {
    const confirmed: string[] = [];
    const { conversation, tasks } = harness([succeeded(RECOMMENDATION), succeeded(CONFIRMATION), succeeded(FINAL)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });
    await conversation.send({ message: 'Prevenção é o centro.', action: 'answer', idempotencyKey: nextKey() });

    const closed = await conversation.confirm({ briefing: 'Clínica de bairro preventiva que equilibra autoridade clínica e proximidade.', idempotencyKey: nextKey() });

    expect(closed.state).toBe('final');
    expect(closed.confirmations).toHaveLength(1);
    expect(closed.confirmations[0]?.revision).toBe(1);
    expect(closed.directions).toHaveLength(3);
    expect(closed.directions.map((entry) => entry.id)).toEqual(['dir-um', 'dir-dois', 'dir-tres']);
    expect(tasks[2]?.brief).toContain('O capitão confirmou o briefing.');
    expect(confirmed).toEqual([]);
  });

  it('signs exactly the text the captain confirmed and records the open gaps beside it', async () => {
    const withGap = turn({ ...CONFIRMATION, unknowns: [{ gap: 'Faixa de preço percebida', impact: 'Muda o quanto a identidade pode parecer premium.' }] } as Partial<BriefingConversationTurn> & Pick<BriefingConversationTurn, 'intent' | 'nextState'>);
    const { conversation } = harness([succeeded(withGap), succeeded(FINAL)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    const closed = await conversation.confirm({ briefing: 'Clínica de bairro preventiva.', idempotencyKey: nextKey() });

    expect(closed.confirmations[0]?.briefing).toBe('Clínica de bairro preventiva.');
    expect(closed.briefing).toBe('Clínica de bairro preventiva.');
    expect(closed.confirmations[0]?.openGaps).toEqual([{ gap: 'Faixa de preço percebida', impact: 'Muda o quanto a identidade pode parecer premium.' }]);
  });

  it('opens a new revision on a later edit instead of rewriting the one already signed', async () => {
    const { conversation } = harness([succeeded(RECOMMENDATION), succeeded(CONFIRMATION), succeeded(FINAL), succeeded(FINAL)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });
    await conversation.send({ message: 'Prevenção é o centro.', action: 'answer', idempotencyKey: nextKey() });
    await conversation.confirm({ briefing: 'Primeira versão do briefing.', idempotencyKey: nextKey() });

    const revised = await conversation.confirm({ briefing: 'Segunda versão do briefing, corrigida.', idempotencyKey: nextKey() });

    expect(revised.confirmations.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(revised.confirmations[0]?.briefing).toBe('Primeira versão do briefing.');
    expect(revised.briefing).toBe('Segunda versão do briefing, corrigida.');
  });

  it('keeps the confirmation when the closing turn fails and only loses the directions', async () => {
    const failed: AgentResult = { taskId: 'identity-briefing-conversation-3', status: 'failed', summary: 'O modelo caiu.', errorCode: 'CONVERSATION_PROVIDER_FAILED' };
    const { conversation } = harness([succeeded(CONFIRMATION), failed]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    const closed = await conversation.confirm({ briefing: 'Clínica de bairro preventiva.', idempotencyKey: nextKey() });

    expect(closed.state).toBe('final');
    expect(closed.briefing).toBe('Clínica de bairro preventiva.');
    expect(closed.directions).toEqual([]);
    expect(closed.error?.message).toContain('O briefing foi confirmado mesmo assim');
  });

  it('refuses a confirmation before there is anything to confirm', async () => {
    const { conversation } = harness([]);

    await expect(conversation.confirm({ briefing: 'Qualquer coisa.', idempotencyKey: nextKey() })).rejects.toBeInstanceOf(ConversationError);
  });

  it('refuses an empty briefing at confirmation time', async () => {
    const { conversation } = harness([succeeded(CONFIRMATION)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    await expect(conversation.confirm({ briefing: '   ', idempotencyKey: nextKey() })).rejects.toThrow(/não pode estar vazio/);
  });
});

describe('briefing conversation persistence', () => {
  it('writes itself after every change and rebuilds the same conversation from what it wrote', async () => {
    const { conversation, persisted } = harness([succeeded(RECOMMENDATION), succeeded(QUESTION)]);
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: 'k1' });
    const before = await conversation.send({ message: 'Prevenção é o centro.', action: 'answer', idempotencyKey: 'k2' });

    expect(persisted).toHaveLength(2);
    const restored = harness([]).conversation;
    restored.restore(JSON.stringify(before));

    expect(restored.snapshot()).toEqual(before);
    expect(restored.state).toBe('question');
  });

  it('does not spend a turn for a key the restored conversation already applied', async () => {
    const { conversation } = harness([succeeded(RECOMMENDATION)]);
    const first = await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: 'restart-key' });

    const restored = harness([]);
    restored.conversation.restore(JSON.stringify(first));
    const retried = await restored.conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: 'restart-key' });

    expect(restored.tasks).toHaveLength(0);
    expect(retried.messages).toEqual(first.messages);
  });

  it('treats unreadable persisted state as no conversation rather than as a lost execution', () => {
    const { conversation } = harness([]);

    conversation.restore('{not json');
    conversation.restore(JSON.stringify({ state: 'not-a-state' }));

    expect(conversation.state).toBe('entry');
  });
});

describe('briefing conversation durability', () => {
  it('leaves the conversation where the execution says it is when the write fails, so a retry does not duplicate the turn', async () => {
    let failWrite = true;
    const { conversation, tasks, persisted } = harness([succeeded(RECOMMENDATION), succeeded(RECOMMENDATION)], {
      persist: async () => { if (failWrite) { failWrite = false; throw new Error('SQLITE_BUSY'); } },
    });
    const retried = 'same-key';

    await expect(conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: retried })).rejects.toThrow(/SQLITE_BUSY/);
    expect(conversation.state).toBe('entry');
    expect(conversation.snapshot().messages).toEqual([]);

    const recovered = await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: retried });

    expect(recovered.messages.filter((message) => message.author === 'captain')).toHaveLength(1);
    expect(recovered.messages).toHaveLength(2);
    expect(persisted).toHaveLength(1);
    expect(tasks).toHaveLength(2);
  });

  it('moves the execution briefing only after the conversation is written, never before', async () => {
    const confirmed: Array<{ briefing: string; revision: number }> = [];
    const { conversation } = harness([succeeded(CONFIRMATION), succeeded(FINAL)], {
      persist: async (snapshot) => { if (snapshot.confirmations.length > 0) throw new Error('SQLITE_BUSY'); },
      onConfirmed: (briefing, revision) => { confirmed.push({ briefing, revision }); },
    });
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    await expect(conversation.confirm({ briefing: 'Clínica de bairro preventiva.', idempotencyKey: nextKey() })).rejects.toThrow(/SQLITE_BUSY/);

    expect(confirmed).toEqual([]);
    expect(conversation.state).toBe('confirmation');
    expect(conversation.confirmedBriefing).toBeUndefined();
    expect(conversation.snapshot().confirmations).toEqual([]);
  });

  it('keeps the turn the execution already recorded when the briefing write fails afterwards', async () => {
    const { conversation, persisted } = harness([succeeded(CONFIRMATION), succeeded(FINAL)], {
      onConfirmed: () => { throw new Error('updateRunBriefing falhou'); },
    });
    await conversation.send({ message: 'Clínica veterinária de bairro.', action: 'answer', idempotencyKey: nextKey() });

    await expect(conversation.confirm({ briefing: 'Clínica de bairro preventiva.', idempotencyKey: nextKey() })).rejects.toThrow(/updateRunBriefing/);

    expect(conversation.state).toBe('final');
    expect(conversation.snapshot()).toEqual(persisted.at(-1));
  });

  it('offers a safe-mode summary the captain can confirm, even from an entry text that fills the briefing limit', async () => {
    const long = `Somos uma clínica veterinária de bairro. ${'Detalhe do atendimento diário. '.repeat(260)}`.slice(0, IDENTITY_BRIEFING_MAX_LENGTH);
    const failure: AgentResult = { taskId: 'identity-briefing-conversation-1', status: 'failed', summary: 'O modelo caiu.', errorCode: 'CONVERSATION_PROVIDER_FAILED' };
    const { conversation } = harness([failure, succeeded(FINAL)]);

    const safe = await conversation.send({ message: long, action: 'answer', idempotencyKey: nextKey() });

    expect(long.length).toBeGreaterThan(7_500);
    expect(safe.state).toBe('confirmation');
    expect(safe.summary!.length).toBeLessThanOrEqual(IDENTITY_BRIEFING_MAX_LENGTH);

    const closed = await conversation.confirm({ briefing: safe.summary!, idempotencyKey: nextKey() });

    expect(closed.state).toBe('final');
    expect(closed.confirmations).toHaveLength(1);
  });

  it('opens on the execution briefing the moment the turn needs it, not on the one captured at construction', async () => {
    let briefing: string | undefined;
    const { conversation } = harness([succeeded(RECOMMENDATION)], { initialText: () => briefing });
    briefing = 'Clínica veterinária de bairro restaurada da execução.';

    const opened = await conversation.send({ action: 'answer', idempotencyKey: nextKey() });

    expect(opened.normalizedText).toBe('Clínica veterinária de bairro restaurada da execução.');
    expect(opened.state).toBe('recommendation');
  });
});

describe('briefing conversation contract', () => {
  it('agrees with itself about which states accept a message, a confirmation and a transition', () => {
    for (const state of ['entry', 'recommendation', 'question', 'confirmation'] as const) expect(canSendBriefingMessage(state)).toBe(true);
    for (const state of ['final', 'cancelled', 'failed'] as const) expect(canSendBriefingMessage(state)).toBe(false);
    expect(BRIEFING_CONVERSATION_TRANSITIONS.cancelled).toEqual([]);
    expect(canBriefingConversationTransition('question', 'recommendation')).toBe(true);
    expect(canBriefingConversationTransition('confirmation', 'question')).toBe(true);
    expect(canBriefingConversationTransition('final', 'question')).toBe(false);
    expect(canBriefingConversationTransition('final', 'final')).toBe(true);
    expect(BRIEFING_CONVERSATION_MAX_QUESTIONS).toBe(6);
  });

  it('rejects a turn whose intent and next state disagree', () => {
    const parsed = briefingConversationTurnSchema.safeParse({ ...RECOMMENDATION, nextState: 'confirmation' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a turn carrying more than the one question the plan allows', () => {
    const parsed = briefingConversationTurnSchema.safeParse({ ...QUESTION, questions: [{ text: 'a', why: 'b' }] });
    expect(parsed.success).toBe(false);
  });

  it('names every kind of visual output it refuses', () => {
    expect(findVisualOutput('paleta de areia e verde folha')).toEqual([]);
    expect(findVisualOutput('<div>home</div>')).toContain('markup');
    expect(findVisualOutput('use #0a7d5c')).toContain('hex-color');
    expect(findVisualOutput('color.brand.primary')).toContain('token-path');
    expect(findVisualOutput('veja https://exemplo.com')).toContain('link');
    expect(findVisualOutput('anexo logo.png')).toContain('image-file');
    expect(findVisualOutput('use #0a7d5c', 'a marca já usa #0a7d5c hoje')).toEqual([]);
    expect(findVisualOutput('use #0a7d5c', 'a marca é verde e quente')).toContain('hex-color');
    expect(findVisualOutput('veja https://exemplo.com', 'nosso site é https://exemplo.com')).toEqual([]);
    expect(findVisualOutput('veja https://outro.com', 'nosso site é https://exemplo.com')).toContain('link');
    expect(findVisualOutput('anexo mockup.png', 'o logo atual está em logo.png')).toContain('image-file');
    expect(findVisualOutput('<div>home</div>', 'o capitão escreveu <div>home</div>')).toContain('markup');
    expect(findVisualOutput('color.brand.primary', 'color.brand.primary')).toContain('token-path');
  });

  it('builds the safe summary out of the captain words alone', () => {
    const summary = deterministicSummary({
      normalizedText: 'Clínica veterinária de bairro.',
      askedQuestions: [{ index: 0, question: 'Autoridade ou proximidade?', why: 'Muda o tom.', answer: 'As duas.', skipped: false }],
      openGaps: [{ gap: 'Faixa de preço', impact: 'Muda o quanto pode parecer premium.' }],
      messages: [],
    });

    expect(summary).toContain('Clínica veterinária de bairro.');
    expect(summary).toContain('Autoridade ou proximidade? → As duas.');
    expect(summary).toContain('Faixa de preço (impacto: Muda o quanto pode parecer premium.)');
  });
});
