/**
 * A deterministic conversation the tests and the fake API drive. It is the
 * veterinary clinic the plan uses as its worked example, so the copy on screen
 * in a test is the copy the plan asked for.
 *
 * Every builder returns fresh data on each call: callers mutate what they get.
 */
import type { ConversationDirection, ConversationQuestion, ConversationSnapshot, ConversationTurn } from './contract.js';

export const CONVERSATION_MESSAGE_LIMIT = 6;
export const CONVERSATION_BRIEFING_MAX_LENGTH = 8000;

export function entryTurn(message: string): ConversationTurn {
  return { id: 'turn-entry', role: 'captain', message, intent: 'entry', facts: [], hypotheses: [], unknowns: [], nextState: 'recommendation' };
}

export function recommendationTurn(): ConversationTurn {
  return {
    id: 'turn-recommendation',
    role: 'studio',
    message: 'O centro parece ser uma clínica parceira: próxima, preventiva e confiável. Eu manteria “cuidado contínuo” como eixo, com linguagem acolhedora e direta.',
    intent: 'recommendation',
    facts: ['Atende cães e gatos no bairro.', 'A prevenção é o serviço central.'],
    hypotheses: ['O público quer acompanhamento, não só consulta avulsa.'],
    unknowns: ['Qual é o receio que impede a primeira visita.'],
    nextState: 'question',
  };
}

export function clarifyingQuestion(): ConversationQuestion {
  return {
    id: 'question-first-visit',
    prompt: 'Na primeira visita, o que precisa acontecer: a pessoa sentir segurança para uma decisão clínica, perceber carinho no atendimento, ou reconhecer uma experiência mais premium?',
    why: 'Esse trade-off decide o tom e a composição das três direções; sem ele, as direções saem parecidas.',
    options: ['Segurança clínica', 'Carinho no atendimento', 'Experiência premium'],
  };
}

export function questionTurn(): ConversationTurn {
  return { id: 'turn-question', role: 'studio', message: clarifyingQuestion().prompt, intent: 'question', question: clarifyingQuestion(), facts: [], hypotheses: [], unknowns: [], nextState: 'question' };
}

export function answerTurn(message: string): ConversationTurn {
  return { id: 'turn-answer', role: 'captain', message, intent: 'answer', facts: [], hypotheses: [], unknowns: [], nextState: 'confirmation' };
}

export const CONSOLIDATED_SUMMARY = 'Clínica veterinária de bairro, preventiva, para cães e gatos. A identidade deve equilibrar autoridade clínica e proximidade cotidiana, com acompanhamento como prova. Exclusões: hospital frio e pet shop genérico.';

export function confirmationTurn(): ConversationTurn {
  return {
    id: 'turn-confirmation',
    role: 'studio',
    message: 'Entendi: a marca deve equilibrar autoridade clínica e proximidade cotidiana. Posso fechar o briefing assim?',
    intent: 'confirmation',
    facts: ['Acompanhamento é a prova declarada.'],
    hypotheses: [],
    unknowns: [],
    summary: CONSOLIDATED_SUMMARY,
    nextState: 'confirmation',
  };
}

export function conceptualDirections(): ConversationDirection[] {
  return [
    { id: 'laco-de-rotina', label: 'Laço de rotina', thesis: 'Uma clínica parceira que conhece a história do animal.', positioning: 'Prevenção traduzida em pequenos próximos passos.', tone: 'Acolhedor, claro e sem infantilizar.', composition: 'Gestos orgânicos e respiro; areia, verde folha e terracota suave.', typography: 'Serif humana para vínculo + sans funcional para orientação.' },
    { id: 'clareza-clinica', label: 'Clareza clínica', thesis: 'Autoridade que organiza decisões e dá segurança.', positioning: 'A clínica que explica o que está acontecendo.', tone: 'Sereno, didático e objetivo.', composition: 'Hierarquia firme; azul-petróleo, branco quente e coral como sinal.', typography: 'Sans de alta legibilidade + serif pontual para confiança.' },
    { id: 'casa-dos-bichos', label: 'Casa dos bichos', thesis: 'Uma marca de comunidade que torna a prevenção parte do bairro.', positioning: 'O lugar onde cuidar do animal vira hábito compartilhado.', tone: 'Vivo, caloroso e convidativo.', composition: 'Ritmo modular e contraste; amarelo manteiga, azul profundo e verde sálvia.', typography: 'Sans arredondada para proximidade + display de apoio.' },
  ];
}

export function conversationSnapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    runId: 'identity-conversation-fixture',
    state: 'entry',
    briefing: '',
    turns: [],
    summary: '',
    messageCount: 0,
    limits: { messageLimit: CONVERSATION_MESSAGE_LIMIT, briefingMaxLength: CONVERSATION_BRIEFING_MAX_LENGTH },
    directions: [],
    ...overrides,
  };
}
