import type { Page, Route } from '@playwright/test';
import { BRIEFING_CONVERSATION_MAX_QUESTIONS, type BriefingConversationSnapshot } from '@pwb/domain/conversation';
import {
  conceptualDirections,
  confirmationTurn,
  message,
  questionTurn,
  recommendationTurn,
  wireSnapshot,
} from '../../apps/studio/src/briefing/conversation-fixture.js';

/**
 * The briefing conversation the Studio talks to in the E2E suite: the shared
 * contract's own states in sequence, an idempotency ledger and the failures the
 * plan's limits table names. It answers in the wire shapes of
 * `@pwb/domain/conversation` — the same ones the server answers with — so this
 * suite drives the panel deterministically without ever inventing a second
 * contract for it to read.
 */
export interface FakeConversationOptions {
  /** Start the run with a conversation already at this point, as a restart would find it. */
  initial?: Partial<BriefingConversationSnapshot>;
  /** Answer the next conversation request with no answer at all (a dead network). */
  dropNextRequest?: boolean;
  /** Answer the next conversation request with a body that is not in the contract. */
  breakNextResponse?: boolean;
  /** Answer every conversation read with 404, the way a server without the endpoints does. */
  absent?: boolean;
  /** The identity run's status, so a test that must sit idle is not re-rendered by the Studio's own polling. */
  runStatus?: string;
}

function identityRun(runId: string, briefing: string, status: string): Record<string, unknown> {
  return {
    runId,
    status,
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
  private conversation: BriefingConversationSnapshot;
  private readonly runId = 'identity-conversation-e2e';
  private briefing = '';
  private readonly ledger = new Map<string, BriefingConversationSnapshot>();
  /** Every conversation write the fake received, keyed request included, so a test can prove a retry did not duplicate a turn. */
  readonly writes: Array<{ path: string; body: Record<string, unknown> }> = [];

  constructor(private readonly options: FakeConversationOptions = {}) {
    this.conversation = wireSnapshot({ runId: this.runId, ...options.initial });
    this.briefing = this.conversation.originalText;
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
      if (this.options.breakNextResponse) { this.options.breakNextResponse = false; await json(route, 200, { runId: this.runId, state: 'recommendation', messages: 'nenhuma' }); return; }
      if (this.options.absent) { await json(route, 404, { error: 'Conversa não encontrada.' }); return; }
      if (method === 'GET') { await json(route, 200, this.conversation); return; }
      const body = request.postDataJSON() as Record<string, unknown>;
      this.writes.push({ path, body });
      await json(route, 200, this.advance(path.endsWith('/confirm') ? 'confirm' : String(body.action), body));
      return;
    }

    if (path.endsWith('/api/identity/runs') && method === 'POST') {
      this.briefing = String((request.postDataJSON() as { briefing?: string }).briefing ?? '');
      await json(route, 200, this.identity());
      return;
    }
    await json(route, 200, this.identity());
  }

  private identity(): Record<string, unknown> {
    return identityRun(this.runId, this.briefing, this.options.runStatus ?? 'queued');
  }

  private append(current: BriefingConversationSnapshot, entries: Array<Parameters<typeof message>[1]>): BriefingConversationSnapshot['messages'] {
    return [...current.messages, ...entries.map((entry, offset) => message(current.messages.length + offset, entry))];
  }

  /**
   * The contract's own machine, plus the ledger that makes a repeated key a
   * no-op rather than a second turn. `entry -> recommendation` and
   * `recommendation -> question` are the moves the contract declares; nothing
   * here skips one to shorten a test.
   */
  private advance(action: string, body: Record<string, unknown>): BriefingConversationSnapshot {
    const key = String(body.idempotencyKey ?? '');
    const seen = this.ledger.get(key);
    if (seen) return seen;

    const current = this.conversation;
    const text = String(body.briefing ?? body.message ?? 'Prefiro não responder essa pergunta agora.');
    let next: BriefingConversationSnapshot;
    if (action === 'cancel') {
      next = { ...current, state: 'cancelled', messages: this.append(current, [{ author: 'system', text: 'Conversa cancelada pelo capitão.', state: 'cancelled' }]) };
    } else if (action === 'confirm') {
      next = {
        ...current,
        state: 'final',
        summary: text,
        briefing: text,
        directions: conceptualDirections(),
        confirmations: [...current.confirmations, { revision: current.confirmations.length + 1, briefing: text, openGaps: [], confirmedAt: '2026-09-11T12:00:00.000Z', messageCount: current.messages.length }],
        messages: this.append(current, [{ author: 'captain', text, state: current.state }]),
      };
    } else if (current.state === 'entry') {
      const turn = recommendationTurn();
      next = {
        ...current,
        state: 'recommendation',
        originalText: text,
        normalizedText: text,
        messages: this.append(current, [{ author: 'captain', text, state: 'entry' }, { author: 'studio', text: turn.message, state: 'recommendation', turn }]),
      };
    } else if (current.state === 'recommendation') {
      const turn = questionTurn();
      const questionCount = current.questionCount + 1;
      next = {
        ...current,
        state: 'question',
        questionCount,
        limitReached: questionCount >= BRIEFING_CONVERSATION_MAX_QUESTIONS,
        messages: this.append(current, [{ author: 'captain', text, state: 'recommendation' }, { author: 'studio', text: turn.message, state: 'question', turn }]),
      };
    } else {
      const turn = confirmationTurn();
      next = {
        ...current,
        state: 'confirmation',
        summary: turn.summary ?? '',
        messages: this.append(current, [{ author: 'captain', text, state: current.state }, { author: 'studio', text: turn.message, state: 'confirmation', turn }]),
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
