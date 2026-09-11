import type { Page, Route } from '@playwright/test';

/**
 * The briefing conversation the Studio talks to in the E2E suite: the five
 * states in sequence, an idempotency ledger and the two failures the plan's
 * limits table names. It is a fake of the contract the server slice publishes,
 * so this suite can exercise the interface before that branch lands.
 */
export interface FakeConversationOptions {
  /** The message ceiling the Studio must read from the contract rather than assume. */
  messageLimit?: number;
  /** Start the run with a conversation already at this point, as a restart would find it. */
  initial?: Partial<ConversationBody>;
  /** Answer the next conversation request with no answer at all (a dead network). */
  dropNextRequest?: boolean;
  /** Answer the next conversation request with a body that is not in the contract. */
  breakNextResponse?: boolean;
  /** Answer every conversation read with 404, the way a server without the endpoints does. */
  absent?: boolean;
}

interface ConversationBody {
  runId: string;
  state: 'entry' | 'recommendation' | 'question' | 'confirmation' | 'final' | 'cancelled' | 'failed';
  briefing: string;
  turns: Array<Record<string, unknown>>;
  question?: Record<string, unknown>;
  summary: string;
  messageCount: number;
  limits: { messageLimit: number; briefingMaxLength: number };
  directions: Array<Record<string, unknown>>;
  closedAt?: string;
}

export const CONSOLIDATED_SUMMARY = 'Clínica veterinária de bairro, preventiva, para cães e gatos. A identidade deve equilibrar autoridade clínica e proximidade cotidiana, com acompanhamento como prova. Exclusões: hospital frio e pet shop genérico.';

const question = {
  id: 'question-first-visit',
  prompt: 'Na primeira visita, o que precisa acontecer: a pessoa sentir segurança para uma decisão clínica, perceber carinho no atendimento, ou reconhecer uma experiência mais premium?',
  why: 'Esse trade-off decide o tom e a composição das três direções; sem ele, as direções saem parecidas.',
  options: ['Segurança clínica', 'Carinho no atendimento', 'Experiência premium'],
};

const recommendation = {
  id: 'turn-recommendation',
  role: 'studio',
  message: 'O centro parece ser uma clínica parceira: próxima, preventiva e confiável.',
  intent: 'recommendation',
  facts: ['Atende cães e gatos no bairro.'],
  hypotheses: ['O público quer acompanhamento, não só consulta avulsa.'],
  unknowns: ['Qual é o receio que impede a primeira visita.'],
  nextState: 'question',
};

const directions = [
  { id: 'laco-de-rotina', label: 'Laço de rotina', thesis: 'Uma clínica parceira que conhece a história do animal.', positioning: 'Prevenção traduzida em pequenos próximos passos.', tone: 'Acolhedor, claro e sem infantilizar.', composition: 'Gestos orgânicos e respiro; areia, verde folha e terracota suave.', typography: 'Serif humana + sans funcional.' },
  { id: 'clareza-clinica', label: 'Clareza clínica', thesis: 'Autoridade que organiza decisões e dá segurança.', positioning: 'A clínica que explica o que está acontecendo.', tone: 'Sereno, didático e objetivo.', composition: 'Hierarquia firme; azul-petróleo, branco quente e coral.', typography: 'Sans de alta legibilidade + serif pontual.' },
  { id: 'casa-dos-bichos', label: 'Casa dos bichos', thesis: 'Uma marca de comunidade que torna a prevenção parte do bairro.', positioning: 'O lugar onde cuidar do animal vira hábito compartilhado.', tone: 'Vivo, caloroso e convidativo.', composition: 'Ritmo modular; amarelo manteiga, azul profundo e verde sálvia.', typography: 'Sans arredondada + display de apoio.' },
];

function identityRun(runId: string, briefing: string): Record<string, unknown> {
  return {
    runId,
    status: 'queued',
    baseVersionId: 'version-root',
    briefing,
    directions: [],
    setCritique: { scores: [], rubricGaps: [], unscoredDimensions: [], blocking: [], abstained: false },
    gate: { state: 'open', reason: 'O capitão decide.' },
    approvals: [],
    assets: [],
    failures: [],
  };
}

export class FakeConversationApi {
  private conversation: ConversationBody;
  private readonly runId = 'identity-conversation-e2e';
  private briefing = '';
  private readonly ledger = new Map<string, ConversationBody>();
  /** Every conversation write the fake received, keyed request included, so a test can prove a retry did not duplicate a turn. */
  readonly writes: Array<{ path: string; body: Record<string, unknown> }> = [];

  constructor(private readonly options: FakeConversationOptions = {}) {
    this.conversation = {
      runId: this.runId,
      state: 'entry',
      briefing: '',
      turns: [],
      summary: '',
      messageCount: 0,
      limits: { messageLimit: options.messageLimit ?? 6, briefingMaxLength: 8000 },
      directions: [],
      ...options.initial,
    };
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/identity/**', (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path.endsWith('/conversation') || path.endsWith('/conversation/confirm')) {
      if (this.options.dropNextRequest) { this.options.dropNextRequest = false; await route.abort('failed'); return; }
      if (this.options.breakNextResponse) { this.options.breakNextResponse = false; await json(route, 200, { runId: this.runId, state: 'recommendation' }); return; }
      if (this.options.absent) { await json(route, 404, { error: 'Conversa não encontrada.' }); return; }
      if (method === 'GET') { await json(route, 200, this.conversation); return; }
      const body = request.postDataJSON() as Record<string, unknown>;
      this.writes.push({ path, body });
      await json(route, 200, this.advance(path.endsWith('/confirm') ? 'confirm' : String(body.intent), body));
      return;
    }

    if (path.endsWith('/api/identity/runs') && method === 'POST') {
      this.briefing = String((request.postDataJSON() as { briefing?: string }).briefing ?? '');
      await json(route, 200, identityRun(this.runId, this.briefing));
      return;
    }
    if (method === 'GET') { await json(route, 200, identityRun(this.runId, this.briefing)); return; }
    await json(route, 200, identityRun(this.runId, this.briefing));
  }

  /** The state machine, plus the ledger that makes a repeated key a no-op rather than a second turn. */
  private advance(intent: string, body: Record<string, unknown>): ConversationBody {
    const key = String(body.idempotencyKey ?? '');
    const seen = this.ledger.get(key);
    if (seen) return seen;

    const current = this.conversation;
    const message = String(body.summary ?? body.message ?? '');
    let next: ConversationBody;
    if (intent === 'cancel') {
      next = { ...current, state: 'cancelled' };
    } else if (intent === 'confirm') {
      next = { ...current, state: 'final', summary: message, briefing: message, closedAt: '2026-09-11T12:00:00.000Z', directions, question: undefined };
    } else if (intent === 'entry') {
      next = {
        ...current,
        state: 'question',
        briefing: message,
        turns: [...current.turns, { id: 'turn-entry', role: 'captain', message, intent: 'entry', facts: [], hypotheses: [], unknowns: [], nextState: 'recommendation' }, recommendation, { id: 'turn-question', role: 'studio', message: question.prompt, intent: 'question', question, facts: [], hypotheses: [], unknowns: [], nextState: 'question' }],
        question,
        messageCount: current.messageCount + 1,
      };
    } else {
      next = {
        ...current,
        state: 'confirmation',
        turns: [
          ...current.turns,
          ...(intent === 'skip' ? [{ id: `turn-skip-${current.messageCount}`, role: 'captain', message: 'Pulei esta pergunta.', intent: 'skip', facts: [], hypotheses: [], unknowns: [], nextState: 'confirmation' }] : [{ id: `turn-answer-${current.messageCount}`, role: 'captain', message, intent: 'answer', facts: [], hypotheses: [], unknowns: [], nextState: 'confirmation' }]),
          { id: `turn-confirmation-${current.messageCount}`, role: 'studio', message: 'Posso fechar o briefing assim?', intent: 'confirmation', facts: ['Acompanhamento é a prova declarada.'], hypotheses: [], unknowns: [], summary: CONSOLIDATED_SUMMARY, nextState: 'confirmation' },
        ],
        question: undefined,
        summary: CONSOLIDATED_SUMMARY,
        messageCount: current.messageCount + 1,
      };
    }
    this.ledger.set(key, next);
    this.conversation = next;
    return next;
  }
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
