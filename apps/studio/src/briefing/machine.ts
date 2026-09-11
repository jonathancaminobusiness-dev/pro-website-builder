/**
 * Everything the conversation panel knows that the server does not: which
 * intent is in flight, what failed, and the text the captain has typed but not
 * sent. It is a pure reducer so the states the plan's limits table requires —
 * loading, network error, invalid response, retry, cancel, limit, restart,
 * omitted field — are decided in one place and can be tested without a browser.
 *
 * The rule that shapes it: a failure keeps the pending intent. Retry re-sends
 * that same intent, with the idempotency key it already carried, so no repeat
 * adds a bubble on screen or a turn on the server.
 */
import { RequestError } from '../request.js';
import {
  ConversationContractError,
  briefingClosed,
  limitReached,
  type ConversationConfirmRequest,
  type ConversationSendRequest,
  type ConversationSnapshot,
} from './contract.js';

export type PendingIntent =
  | { kind: 'resume' }
  | { kind: 'send'; request: ConversationSendRequest }
  | { kind: 'confirm'; request: ConversationConfirmRequest };

export type FailureKind = 'network' | 'invalid' | 'refused';

export interface ConversationFailure {
  kind: FailureKind;
  message: string;
}

/**
 * `availability` is how the screen tells "this server has no conversation for
 * this run" (the old flow keeps working) from "we have not asked yet".
 */
export interface ConversationUiState {
  runId: string;
  availability: 'unknown' | 'available' | 'absent';
  snapshot: ConversationSnapshot | null;
  /** The initial text or the answer being typed. Never cleared by a failure. */
  draft: string;
  /** The consolidated summary as the captain is editing it. */
  summaryDraft: string;
  pending: PendingIntent | null;
  failure: ConversationFailure | null;
}

export type ConversationAction =
  | { type: 'reset'; runId: string }
  | { type: 'resumed'; snapshot: ConversationSnapshot | null }
  | { type: 'draft'; value: string }
  | { type: 'summaryDraft'; value: string }
  | { type: 'begin'; intent: PendingIntent }
  | { type: 'retry' }
  | { type: 'settled'; snapshot: ConversationSnapshot }
  | { type: 'failed'; failure: ConversationFailure };

/**
 * What the editable summary starts from. The server's consolidated summary when
 * there is one; otherwise the captain's own text, so a conversation that hit a
 * ceiling before the Studio wrote a summary still has something to edit and
 * close manually rather than a disabled button over an empty field.
 */
function summarySeed(snapshot: ConversationSnapshot): string {
  return snapshot.summary !== '' ? snapshot.summary : snapshot.briefing;
}

export function initialConversationState(runId: string): ConversationUiState {
  return { runId, availability: 'unknown', snapshot: null, draft: '', summaryDraft: '', pending: null, failure: null };
}

export function classifyFailure(cause: unknown): ConversationFailure {
  if (cause instanceof ConversationContractError) {
    return { kind: 'invalid', message: 'A resposta da conversa não seguiu o contrato, então nada avançou e nada foi fechado. Tente de novo; se repetir, feche o briefing pelo resumo editável.' };
  }
  if (cause instanceof RequestError && cause.status !== undefined) {
    return { kind: 'refused', message: cause.message };
  }
  if (cause instanceof RequestError) {
    return { kind: 'network', message: 'A conversa não chegou ao servidor. Nada foi fechado e o que você escreveu continua aqui. Tente novamente.' };
  }
  return { kind: 'network', message: cause instanceof Error ? cause.message : 'Erro desconhecido na conversa.' };
}

export function conversationReducer(state: ConversationUiState, action: ConversationAction): ConversationUiState {
  switch (action.type) {
    case 'reset':
      return initialConversationState(action.runId);
    case 'resumed':
      return action.snapshot === null
        ? { ...state, availability: 'absent', snapshot: null, pending: null, failure: null }
        : { ...state, availability: 'available', snapshot: action.snapshot, summaryDraft: summarySeed(action.snapshot), pending: null, failure: null };
    case 'draft':
      return { ...state, draft: action.value };
    case 'summaryDraft':
      return { ...state, summaryDraft: action.value };
    case 'begin':
      return { ...state, pending: action.intent, failure: null };
    // A retry keeps the pending intent exactly as it was — same kind, same body,
    // same idempotency key — and only clears the error the captain just read.
    case 'retry':
      return state.pending === null ? state : { ...state, failure: null };
    case 'settled': {
      const clearsDraft = state.pending?.kind === 'send' && (state.pending.request.intent === 'entry' || state.pending.request.intent === 'answer');
      return {
        ...state,
        availability: 'available',
        snapshot: action.snapshot,
        summaryDraft: summarySeed(action.snapshot),
        draft: clearsDraft ? '' : state.draft,
        pending: null,
        failure: null,
      };
    }
    case 'failed':
      return { ...state, failure: action.failure };
  }
}

/**
 * The captain's message that is in flight, shown once as a pending bubble. A
 * retry does not add a second one because it reuses the same pending intent.
 */
export function pendingMessage(state: ConversationUiState): string | null {
  if (state.pending?.kind !== 'send') return null;
  const { intent, message } = state.pending.request;
  if (intent === 'skip') return 'Pular esta pergunta';
  if (intent === 'cancel') return 'Cancelar a conversa';
  return message;
}

/** What is happening right now, named for the captain and for the live region. */
export function progressLabel(state: ConversationUiState): string | null {
  switch (state.pending?.kind) {
    case 'resume': return 'Reabrindo a conversa desta execução…';
    case 'confirm': return 'Fechando o briefing…';
    case 'send':
      switch (state.pending.request.intent) {
        case 'entry': return 'Lendo o texto do briefing…';
        case 'answer': return 'Registrando a resposta…';
        case 'skip': return 'Pulando a pergunta…';
        case 'cancel': return 'Cancelando a conversa…';
      }
      return 'Enviando…';
    default: return null;
  }
}

export interface ConversationAffordances {
  /** The panel has a conversation to show. */
  ready: boolean;
  /** Any request is in flight: duplicate sends are refused while it is. */
  busy: boolean;
  canSendEntry: boolean;
  canAnswer: boolean;
  canSkip: boolean;
  canCancel: boolean;
  canConfirm: boolean;
  /** A question is open: the same condition that decides whether it can be answered or skipped. */
  asking: boolean;
  /**
   * The editable summary and its manual close are the way out. Every state that
   * stopped asking and did not close the briefing offers them — a consolidated
   * summary, a reached ceiling, a cancelled conversation, a failed one — so no
   * state leaves the captain without a “Fechar briefing”.
   */
  summaryOpen: boolean;
  /** A ceiling was reached: the panel stops asking and offers the editable summary and a manual close. */
  atLimit: boolean;
  closed: boolean;
  /** The failed request can be sent again with the intent it already had. */
  canRetry: boolean;
}

export function affordances(state: ConversationUiState, now: Date): ConversationAffordances {
  const snapshot = state.snapshot;
  const busy = state.pending !== null && state.failure === null;
  const ready = state.availability === 'available' && snapshot !== null;
  if (!ready || snapshot === null) {
    return { ready: false, busy, canSendEntry: false, canAnswer: false, canSkip: false, canCancel: false, canConfirm: false, asking: false, summaryOpen: false, atLimit: false, closed: false, canRetry: state.pending !== null && state.failure !== null };
  }
  const closed = briefingClosed(snapshot);
  const halted = snapshot.state === 'cancelled' || snapshot.state === 'failed';
  const atLimit = limitReached(snapshot, now) && !closed && !halted;
  const typed = state.draft.trim() !== '';
  const asking = !closed && snapshot.state === 'question' && snapshot.question !== undefined && !atLimit;
  const summaryOpen = !closed && (snapshot.state === 'confirmation' || atLimit || halted);
  return {
    ready: true,
    busy,
    canSendEntry: !busy && !atLimit && snapshot.state === 'entry' && typed,
    canAnswer: !busy && asking && typed,
    canSkip: !busy && asking,
    canCancel: !busy && !closed && !halted,
    canConfirm: !busy && summaryOpen && state.summaryDraft.trim() !== '',
    asking,
    summaryOpen,
    atLimit,
    closed,
    canRetry: state.pending !== null && state.failure !== null,
  };
}
