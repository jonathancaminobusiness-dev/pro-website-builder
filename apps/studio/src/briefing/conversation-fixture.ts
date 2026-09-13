/**
 * A deterministic conversation the tests and the fake API drive. It is the
 * veterinary clinic the plan uses as its worked example, so the copy on screen
 * in a test is the copy the plan asked for.
 *
 * Everything here is built in the shared contract's own shapes — the wire the
 * server answers with — and the view the panel reads is obtained by parsing it,
 * exactly as the client does. A fixture that spoke the view model directly
 * would be a second contract, and the drift it hid is the whole reason this
 * module exists.
 *
 * Every builder returns fresh data on each call: callers mutate what they get.
 */
import {
  BRIEFING_CONVERSATION_MAX_QUESTIONS,
  type BriefingConversationMessage,
  type BriefingConversationSnapshot,
  type BriefingConversationTurn,
  type BriefingQuestion,
  type ConceptualDirection,
} from '@pwb/domain/conversation';
import { parseConversationSnapshot, type ConversationSnapshot } from './contract.js';

export const CONVERSATION_QUESTION_LIMIT = BRIEFING_CONVERSATION_MAX_QUESTIONS;

export const FIRST_TEXT = 'Somos uma clínica veterinária de bairro. Queremos cuidar de cães e gatos com prevenção, sem parecer hospital frio nem pet shop genérico.';

let clock = 0;
function stamp(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
}

/** One transcript entry, numbered by its position the way the server numbers them. */
export function message(index: number, entry: Omit<BriefingConversationMessage, 'id' | 'index' | 'createdAt' | 'fallback'> & { fallback?: boolean }): BriefingConversationMessage {
  return {
    id: `msg-${index}`,
    index,
    author: entry.author,
    text: entry.text,
    createdAt: stamp(),
    state: entry.state,
    ...(entry.turn ? { turn: structuredClone(entry.turn) } : {}),
    fallback: entry.fallback ?? false,
  };
}

export function recommendationTurn(): BriefingConversationTurn {
  return {
    message: 'O centro parece ser uma clínica parceira: próxima, preventiva e confiável. Eu manteria “cuidado contínuo” como eixo, com linguagem acolhedora e direta.',
    intent: 'recommendation',
    facts: ['Atende cães e gatos no bairro.', 'A prevenção é o serviço central.'],
    hypotheses: ['O público quer acompanhamento, não só consulta avulsa.'],
    unknowns: [{ gap: 'Qual é o receio que impede a primeira visita.', impact: 'Decide o que a marca precisa desarmar logo na primeira tela.' }],
    nextState: 'recommendation',
  };
}

export function clarifyingQuestion(): BriefingQuestion {
  return {
    text: 'Na primeira visita, o que precisa acontecer: a pessoa sentir segurança para uma decisão clínica, perceber carinho no atendimento, ou reconhecer uma experiência mais premium?',
    why: 'Esse trade-off decide o tom e a composição das três direções; sem ele, as direções saem parecidas.',
    options: ['Segurança clínica', 'Carinho no atendimento', 'Experiência premium'],
  };
}

export function questionTurn(question: BriefingQuestion = clarifyingQuestion()): BriefingConversationTurn {
  return { message: question.text, intent: 'question', question, facts: [], hypotheses: [], unknowns: [], nextState: 'question' };
}

/** A second clarifying question, so a test can tell the open one from the one already answered. */
export function followUpQuestion(): BriefingQuestion {
  return {
    text: 'Qual prova de acompanhamento a marca pode mostrar: retorno agendado, histórico do animal ou plano de prevenção?',
    why: 'A prova escolhida decide o que as três direções mostram como evidência.',
    options: [],
  };
}

export const CONSOLIDATED_SUMMARY = 'Clínica veterinária de bairro, preventiva, para cães e gatos. A identidade deve equilibrar autoridade clínica e proximidade cotidiana, com acompanhamento como prova. Exclusões: hospital frio e pet shop genérico.';

export function confirmationTurn(): BriefingConversationTurn {
  return {
    message: 'Entendi: a marca deve equilibrar autoridade clínica e proximidade cotidiana. Posso fechar o briefing assim?',
    intent: 'confirmation',
    facts: ['Acompanhamento é a prova declarada.'],
    hypotheses: [],
    unknowns: [],
    summary: CONSOLIDATED_SUMMARY,
    nextState: 'confirmation',
  };
}

export function conceptualDirections(): ConceptualDirection[] {
  return [
    {
      id: 'dir-laco-de-rotina',
      label: 'Laço de rotina',
      positioning: 'Uma clínica parceira que conhece a história do animal e traduz prevenção em pequenos próximos passos.',
      tone: 'Acolhedor, claro e sem infantilizar.',
      visualLanguage: 'Gestos orgânicos, fotografia de convívio e muito respiro entre os blocos.',
      palette: 'Areia quente, verde folha e um terracota suave como sinal de afeto.',
      typography: 'Serif humana para o vínculo, sans funcional para a orientação.',
      composition: 'Colunas largas e ritmo calmo, com a próxima ação sempre visível.',
      applications: ['Cartão de acompanhamento', 'Lembrete de retorno'],
    },
    {
      id: 'dir-clareza-clinica',
      label: 'Clareza clínica',
      positioning: 'A clínica que explica o que está acontecendo e organiza a decisão com o tutor.',
      tone: 'Sereno, didático e objetivo.',
      visualLanguage: 'Diagramas simples, muito branco e fotografia de procedimento sem dramatizar.',
      palette: 'Azul profundo, branco quente e um coral pontual como sinal.',
      typography: 'Sans de alta legibilidade com serif pontual para confiança.',
      composition: 'Hierarquia firme, listas curtas e uma decisão por tela.',
      applications: ['Guia de exames', 'Resumo da consulta'],
    },
    {
      id: 'dir-casa-dos-bichos',
      label: 'Casa dos bichos',
      positioning: 'Uma marca de comunidade que torna a prevenção um hábito compartilhado no bairro.',
      tone: 'Vivo, caloroso e convidativo.',
      visualLanguage: 'Ilustração leve, recortes e cenas de rua reconhecíveis.',
      palette: 'Amarelo manteiga, azul profundo e verde sálvia.',
      typography: 'Sans arredondada para proximidade com um display de apoio.',
      composition: 'Ritmo modular e contraste alto entre blocos.',
      applications: ['Mural do bairro', 'Convite para o mutirão de vacinação'],
    },
  ];
}

/** A wire snapshot with the contract's own defaults, so a test names only what it is about. */
export function wireSnapshot(overrides: Partial<BriefingConversationSnapshot> = {}): BriefingConversationSnapshot {
  return {
    runId: 'identity-conversation-fixture',
    state: 'entry',
    originalText: '',
    normalizedText: '',
    messages: [],
    openGaps: [],
    askedQuestions: [],
    questionCount: 0,
    attempt: 0,
    fallback: false,
    limitReached: false,
    confirmations: [],
    directions: [],
    appliedKeys: [],
    ...overrides,
  };
}

/** The same fixture as the panel reads it: parsed by the very function the client uses. */
export function conversationSnapshot(overrides: Partial<BriefingConversationSnapshot> = {}): ConversationSnapshot {
  return parseConversationSnapshot(wireSnapshot(overrides));
}

/** The transcript of a conversation that has given its first reading. */
export function afterFirstReading(text: string = FIRST_TEXT): BriefingConversationMessage[] {
  return [
    message(0, { author: 'captain', text, state: 'entry' }),
    message(1, { author: 'studio', text: recommendationTurn().message, state: 'recommendation', turn: recommendationTurn() }),
  ];
}

/** The transcript of a conversation with one question open. */
export function withOpenQuestion(question: BriefingQuestion = clarifyingQuestion(), text: string = FIRST_TEXT): BriefingConversationMessage[] {
  const turn = questionTurn(question);
  return [...afterFirstReading(text), message(2, { author: 'studio', text: turn.message, state: 'question', turn })];
}
