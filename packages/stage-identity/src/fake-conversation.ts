import { BRIEFING_CONVERSATION_STATES, type BriefingConversationState, type BriefingConversationTurn, type ConceptualDirection } from '@pwb/domain';

/**
 * The deterministic briefing conversation the whole journey runs on in CI.
 *
 * It is a fixture, not a model: it reads the state, the question count and the
 * closing instruction out of the prompt the server built — the only inputs a
 * real model gets — and answers with a schema-valid turn. That is enough to
 * exercise the state machine's two controlled returns, the question cap, the
 * confirmation and the three conceptual directions without a paid call.
 *
 * The path it walks is short on purpose: entry → recommendation → question →
 * (answer) → recommendation → confirmation, and then `final` when the captain
 * confirms.
 */
export const FAKE_CONVERSATION_TASK_PREFIX = 'identity-briefing-conversation';

function stateOf(prompt: string): BriefingConversationState {
  const match = /O estado atual da conversa é `([a-z]+)`/.exec(prompt);
  const found = BRIEFING_CONVERSATION_STATES.find((state) => state === match?.[1]);
  return found ?? 'entry';
}

function questionsAsked(prompt: string): number {
  const match = /Perguntas já feitas: (\d+) de \d+/.exec(prompt);
  return match ? Number(match[1]) : 0;
}

function directions(): ConceptualDirection[] {
  return [
    {
      id: 'dir-laco-de-rotina',
      label: 'Laço de rotina',
      positioning: 'Prevenção traduzida em pequenos próximos passos, com quem conhece a história de quem chega.',
      tone: 'Acolhedor, claro e sem infantilizar; verbos de acompanhamento em vez de adjetivos.',
      visualLanguage: 'Gestos orgânicos e respiro largo, com módulos que sugerem continuidade.',
      palette: 'Areia como base calma, verde folha como cuidado contínuo e um terroso morno como sinal.',
      typography: 'Serifa humana para vínculo, apoiada por uma sem-serifa funcional de orientação.',
      composition: 'Blocos encadeados que leem como etapas, nunca como cartões soltos.',
      applications: ['Agenda de acompanhamento', 'Lembretes de rotina', 'Material de recepção'],
    },
    {
      id: 'dir-clareza-clinica',
      label: 'Clareza clínica',
      positioning: 'Autoridade que organiza decisões e devolve segurança sem virar diagnóstico frio.',
      tone: 'Sereno, didático e objetivo; frases curtas e evidência antes de adjetivo.',
      visualLanguage: 'Hierarquia firme, linhas de apoio e blocos de informação legíveis à distância.',
      palette: 'Azul profundo como base técnica, branco morno como respiro e um alaranjado de alerta como sinal.',
      typography: 'Sem-serifa de alta legibilidade, com uma serifa pontual reservada à confiança.',
      composition: 'Grade explícita, com um caminho de leitura único por tela.',
      applications: ['Prontuário', 'Site institucional', 'Sinalização interna'],
    },
    {
      id: 'dir-casa-dos-bichos',
      label: 'Casa dos bichos',
      positioning: 'O lugar onde cuidar vira hábito compartilhado do bairro inteiro.',
      tone: 'Vivo, caloroso e convidativo; chamadas práticas e humor leve.',
      visualLanguage: 'Ritmo modular, formas amigáveis e contraste alto entre cheio e vazio.',
      palette: 'Amarelo manteiga como convite, azul profundo como base e um verde de erva como apoio.',
      typography: 'Sem-serifa arredondada para proximidade, com um display de apoio para chamadas.',
      composition: 'Mosaico com hierarquia por tamanho, feito para leitura rápida.',
      applications: ['Calendário de prevenção', 'Mural de comunidade', 'Fachada'],
    },
  ];
}

const SUMMARY = 'Clínica veterinária de bairro, preventiva, para cães e gatos. A marca precisa equilibrar autoridade clínica e proximidade cotidiana, e ser lembrada pelo acompanhamento e não só pela consulta.';

/** The turn the fixture answers with for one prompt, or undefined when the prompt is not a conversation turn. */
export function fakeBriefingConversationTurn(prompt: string): BriefingConversationTurn {
  const closing = prompt.includes('O capitão confirmou o briefing.');
  if (closing) {
    return {
      message: 'Briefing fechado. Três direções conceituais, descritas em palavras e sem nenhuma peça visual.',
      intent: 'final',
      facts: ['Clínica veterinária de bairro', 'Atende cães e gatos', 'Ênfase em prevenção'],
      hypotheses: ['O acompanhamento é o diferencial lembrado'],
      unknowns: [],
      summary: SUMMARY,
      directions: directions(),
      nextState: 'final',
    };
  }
  const state = stateOf(prompt);
  const asked = questionsAsked(prompt);
  const mustConclude = prompt.includes('Não faça mais perguntas.');
  const conclude = mustConclude || (state === 'recommendation' && asked >= 1);
  if (conclude) {
    return {
      message: 'Acho que já dá para fechar. Revise o resumo e corrija o que estiver errado.',
      intent: 'confirmation',
      facts: ['Clínica veterinária de bairro', 'Prevenção como eixo'],
      hypotheses: ['Autoridade clínica e proximidade precisam conviver'],
      unknowns: [{ gap: 'Faixa de preço percebida', impact: 'Muda o quanto a identidade pode parecer premium.' }],
      summary: SUMMARY,
      nextState: 'confirmation',
    };
  }
  if (state === 'recommendation' || state === 'confirmation') {
    return {
      message: 'Antes de seguir, falta decidir onde a marca quer pousar.',
      intent: 'question',
      question: {
        text: 'Na primeira visita, o que precisa acontecer: segurança para uma decisão clínica, carinho no atendimento ou uma experiência mais premium?',
        why: 'A resposta define o trade-off entre autoridade e proximidade, que muda tom, paleta e composição.',
        options: ['Segurança clínica', 'Carinho no atendimento', 'Experiência premium'],
      },
      facts: ['Clínica veterinária de bairro'],
      hypotheses: ['O eixo é cuidado contínuo'],
      unknowns: [{ gap: 'Onde a marca pousa entre autoridade e proximidade', impact: 'Define tom de voz e princípios de composição.' }],
      nextState: 'question',
    };
  }
  return {
    message: 'Entendi uma clínica parceira: próxima, preventiva e confiável. Mantive cuidado contínuo como eixo.',
    intent: 'recommendation',
    facts: ['Clínica veterinária de bairro', 'Atende cães e gatos', 'Ênfase em prevenção'],
    hypotheses: ['A promessa é acompanhamento e não só consulta'],
    unknowns: [{ gap: 'Onde a marca pousa entre autoridade e proximidade', impact: 'Define tom de voz e princípios de composição.' }],
    nextState: 'recommendation',
  };
}
