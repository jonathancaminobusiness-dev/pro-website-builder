import type { Page, Route } from '@playwright/test';
import type { ConversationSnapshot, ConversationTurn } from '../../apps/studio/src/briefing/contract.js';
import {
  answerTurn,
  clarifyingQuestion,
  conceptualDirections,
  confirmationTurn,
  conversationSnapshot,
  entryTurn,
  questionTurn,
  recommendationTurn,
} from '../../apps/studio/src/briefing/conversation-fixture.js';

/**
 * The briefing conversation the Studio talks to in the E2E suite: the five
 * states in sequence, an idempotency ledger and the two failures the plan's
 * limits table names. It is a fake of the contract the server slice publishes,
 * so this suite can exercise the interface before that branch lands. The
 * conversation it serves is the Studio's own fixture, so the fake and the panel
 * can never drift into two different contracts.
 */
export interface FakeConversationOptions {
  /** The message ceiling the Studio must read from the contract rather than assume. */
  messageLimit?: number;
  /** Start the run with a conversation already at this point, as a restart would find it. */
  initial?: Partial<ConversationSnapshot>;
  /** Answer the next conversation request with no answer at all (a dead network). */
  dropNextRequest?: boolean;
  /** Answer the next conversation request with a body that is not in the contract. */
  breakNextResponse?: boolean;
  /** Answer every conversation read with 404, the way a server without the endpoints does. */
  absent?: boolean;
}

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

/** Turns repeat across a conversation, so each one gets an id of its own. */
function numbered(turn: ConversationTurn, count: number): ConversationTurn {
  return { ...turn, id: `${turn.id}-${count}` };
}

export class FakeConversationApi {
  private conversation: ConversationSnapshot;
  private readonly runId = 'identity-conversation-e2e';
  private briefing = '';
  private readonly ledger = new Map<string, ConversationSnapshot>();
  /** Every conversation write the fake received, keyed request included, so a test can prove a retry did not duplicate a turn. */
  readonly writes: Array<{ path: string; body: Record<string, unknown> }> = [];

  constructor(private readonly options: FakeConversationOptions = {}) {
    this.conversation = conversationSnapshot({ runId: this.runId, ...options.initial });
    if (options.messageLimit !== undefined) this.conversation.limits = { ...this.conversation.limits, messageLimit: options.messageLimit };
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
  private advance(intent: string, body: Record<string, unknown>): ConversationSnapshot {
    const key = String(body.idempotencyKey ?? '');
    const seen = this.ledger.get(key);
    if (seen) return seen;

    const current = this.conversation;
    const message = String(body.summary ?? body.message ?? '');
    const count = current.messageCount;
    let next: ConversationSnapshot;
    if (intent === 'cancel') {
      next = { ...current, state: 'cancelled' };
    } else if (intent === 'confirm') {
      next = { ...current, state: 'final', summary: message, briefing: message, closedAt: '2026-09-11T12:00:00.000Z', directions: conceptualDirections(), question: undefined };
    } else if (intent === 'entry') {
      next = {
        ...current,
        state: 'question',
        briefing: message,
        turns: [...current.turns, entryTurn(message), recommendationTurn(), questionTurn()],
        question: clarifyingQuestion(),
        messageCount: count + 1,
      };
    } else {
      const captainTurn: ConversationTurn = intent === 'skip'
        ? { id: 'turn-skip', role: 'captain', message: 'Pulei esta pergunta.', intent: 'skip', facts: [], hypotheses: [], unknowns: [], nextState: 'confirmation' }
        : answerTurn(message);
      const studioTurn = confirmationTurn();
      next = {
        ...current,
        state: 'confirmation',
        turns: [...current.turns, numbered(captainTurn, count), numbered(studioTurn, count)],
        question: undefined,
        summary: studioTurn.summary ?? '',
        messageCount: count + 1,
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
