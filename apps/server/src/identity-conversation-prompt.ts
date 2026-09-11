import {
  BRIEFING_CONCEPTUAL_DIRECTIONS,
  BRIEFING_CONVERSATION_MAX_QUESTIONS,
  BRIEFING_VISUAL_OUTPUT_RULES,
  briefingConversationTurnJsonSchema,
  briefingTurnNextStates,
  type BriefingAnsweredQuestion,
  type BriefingConversationState,
  type BriefingGap,
} from '@pwb/domain';

/**
 * Everything the model is allowed to see for one briefing turn, and nothing
 * else. The plan lists the input exactly: the current message, the original and
 * normalized briefing, the history that is still needed, the confirmed summary,
 * the open gaps with their impact, the state and turn number.
 *
 * What is deliberately absent is as much part of the contract as what is
 * present: no credential, no machine path, no other execution and no Gate 1
 * decision ever reaches this prompt, because none of them is a field here.
 */
export interface BriefingTurnContext {
  state: BriefingConversationState;
  /** 1 for the first turn of the conversation, and one more for each turn after it. */
  turnNumber: number;
  originalText: string;
  normalizedText: string;
  currentMessage: string;
  /** The captain's last action, so a skip is not read as an answer. */
  action: 'answer' | 'correct' | 'skip';
  history: Array<{ author: 'captain' | 'studio'; text: string }>;
  askedQuestions: BriefingAnsweredQuestion[];
  openGaps: BriefingGap[];
  confirmedSummary?: string;
  questionCount: number;
  /** True once the conversation may no longer ask, so the turn must offer a summary. */
  mustConclude: boolean;
  /** True on the turn the captain's confirmation asks for the conceptual directions. */
  closing: boolean;
}

const FACILITATION = [
  'Você é o facilitador de briefing do Studio. Você não desenha nada e não decide nada pelo capitão.',
  'Escreva sempre em português do Brasil, em tom de facilitação: frases curtas, sem jargão de agência e sem elogio.',
  'Separe explicitamente o que é fato (o capitão disse), o que é hipótese (você inferiu) e o que é desconhecido (ninguém disse ainda). Um item não informado nunca vira prova de negócio, público ou restrição.',
  'Faça no máximo uma pergunta por turno, e só quando a resposta mudaria a direção da identidade. Toda pergunta precisa explicar por que a resposta importa.',
  'Se já houver contexto suficiente, pule as perguntas, ofereça o resumo e diga por que não perguntou.',
].join('\n');

function boundary(): string {
  return [
    'Fronteira de produto: esta conversa é uma camada de preparação, não um gate e não um gerador de preview.',
    'Você pode descrever uma identidade em palavras — posicionamento, tom, linguagem visual, paleta por função e clima, tipografia como intenção, composição e aplicações.',
    'Você não pode produzir logo, imagem, mockup, preview, HTML, JSX, CSS, token, patch, valor hexadecimal, caminho de token, link nem arquivo de imagem.',
    ...BRIEFING_VISUAL_OUTPUT_RULES.map((rule) => `- ${rule.why}`),
    'Uma resposta que tentar qualquer uma dessas saídas é recusada inteira e o turno é perdido.',
  ].join('\n');
}

function machine(context: BriefingTurnContext): string {
  return [
    `O estado atual da conversa é \`${context.state}\`.`,
    `A partir dele, o único \`nextState\` que você pode pedir é: ${briefingTurnNextStates(context.state, context).join(', ')}.`,
    'O campo `intent` e o campo `nextState` precisam ser iguais.',
    context.closing ? 'O capitão já confirmou o resumo, e é isso que fecha o briefing.' : 'Você nunca fecha o briefing sozinho: `final` só acontece quando o capitão confirma o resumo.',
  ].join('\n');
}

/** How the prompt names each move, so the task text can only ask for one the validator accepts. */
const MOVES: Partial<Record<BriefingConversationState, string>> = {
  recommendation: 'devolva uma leitura atualizada do briefing, com `nextState` `recommendation`',
  question: 'faça uma única pergunta, com `nextState` `question`, explicando por que a resposta importa',
  confirmation: 'ofereça o resumo editável para confirmação, com `nextState` `confirmation`',
};

function transcript(history: BriefingTurnContext['history']): string {
  if (history.length === 0) return 'Histórico: esta é a primeira mensagem da conversa.';
  return ['Histórico da conversa, em ordem:', ...history.map((entry) => `${entry.author === 'captain' ? 'Capitão' : 'Studio'}: ${entry.text}`)].join('\n');
}

function gaps(open: BriefingGap[]): string {
  if (open.length === 0) return 'Lacunas abertas: nenhuma registrada até agora.';
  return ['Lacunas abertas e o impacto de cada uma na identidade:', ...open.map((gap) => `- ${gap.gap} — impacto: ${gap.impact}`)].join('\n');
}

function answered(questions: BriefingAnsweredQuestion[]): string {
  if (questions.length === 0) return 'Perguntas já feitas: nenhuma.';
  return ['Perguntas já feitas e o que o capitão respondeu:', ...questions.map((entry) => `- ${entry.question} → ${entry.skipped ? 'pulada pelo capitão' : entry.answer ?? 'ainda sem resposta'}`)].join('\n');
}

function task(context: BriefingTurnContext): string {
  if (context.closing) {
    return [
      `O capitão confirmou o briefing. Responda com \`intent\` e \`nextState\` iguais a \`final\`, repita o briefing confirmado em \`summary\` e proponha exatamente ${BRIEFING_CONCEPTUAL_DIRECTIONS} direções conceituais distintas em \`directions\`.`,
      'Cada direção precisa de posicionamento, tom, linguagem visual, paleta descrita por função e clima, tipografia como intenção, princípios de composição e aplicações imaginadas.',
      'As três direções precisam discordar entre si: se duas chegam à mesma promessa, uma delas está sobrando.',
    ].join('\n');
  }
  const allowed = briefingTurnNextStates(context.state, context);
  const moves = allowed.flatMap((next) => MOVES[next] === undefined ? [] : [MOVES[next]]);
  if (context.mustConclude) {
    return [
      `A conversa atingiu o limite de ${BRIEFING_CONVERSATION_MAX_QUESTIONS} perguntas.`,
      `Não faça mais perguntas. Escolha exatamente um destes movimentos: ${moves.join('; ')}.`,
      'O `summary` precisa trazer o resumo editável do que já foi dito, e `unknowns` o que ficou em aberto.',
    ].join('\n');
  }
  return [
    'Devolva uma leitura útil: o que você entendeu, quais fatos estão claros e qual trade-off parece central.',
    `Depois escolha exatamente um destes movimentos: ${moves.join('; ')}.`,
    ...(allowed.includes('question') ? ['Só pergunte quando a resposta mudaria mesmo a direção da identidade; se não mudaria, ofereça o resumo.'] : []),
  ].join('\n');
}

/**
 * Builds the one prompt a briefing turn spends. A correction carries the same
 * context plus the validation errors, so the retry answers the same question
 * rather than starting a different conversation.
 */
export function briefingConversationPrompt(context: BriefingTurnContext, corrections: string[] = []): string {
  const action = context.action === 'skip' ? 'O capitão pulou a pergunta aberta.' : context.action === 'correct' ? 'O capitão corrigiu algo que você entendeu errado.' : 'O capitão respondeu.';
  return [
    FACILITATION,
    boundary(),
    machine(context),
    `Turno número ${context.turnNumber}. Perguntas já feitas: ${context.questionCount} de ${BRIEFING_CONVERSATION_MAX_QUESTIONS}.`,
    `Texto original do capitão:\n${context.originalText || '(ainda não há texto original)'}`,
    `Texto normalizado que vale como briefing:\n${context.normalizedText || '(ainda não há texto normalizado)'}`,
    context.confirmedSummary ? `Resumo já confirmado pelo capitão:\n${context.confirmedSummary}` : '',
    transcript(context.history),
    answered(context.askedQuestions),
    gaps(context.openGaps),
    `${action} Mensagem atual do capitão:\n${context.currentMessage || '(sem texto)'}`,
    task(context),
    `Responda com um único objeto JSON no campo \`artifact\`, exatamente neste schema:\n${JSON.stringify(briefingConversationTurnJsonSchema)}`,
    corrections.length > 0 ? `A resposta anterior foi recusada. Corrija exatamente estes erros e devolva apenas o JSON válido:\n${corrections.map((problem) => `- ${problem}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
