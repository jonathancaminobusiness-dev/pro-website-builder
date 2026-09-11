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

export interface ConversationFailure {
  message: string;
}

/**
 * `availability` is how the screen tells "this server has no conversation for
 * this run" (the old flow keeps working, and only a 404 says so) from "we have
 * not asked yet" and from "we asked and could not read it".
 */
export interface ConversationUiState {
  availability: 'unknown' | 'available' | 'absent' | 'unreachable';
  snapshot: ConversationSnapshot | null;
  /** The initial text or the answer being typed. Never cleared by a failure. */
  draft: string;
  /** The consolidated summary as the captain is editing it. */
  summaryDraft: string;
  pending: PendingIntent | null;
  failure: ConversationFailure | null;
}

export type ConversationAction =
  | { type: 'reset' }
  | { type: 'resumed'; snapshot: null }
  | { type: 'draft'; value: string }
  | { type: 'summaryDraft'; value: string }
  | { type: 'begin'; intent: PendingIntent }
  | { type: 'discard' }
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

/**
 * The request holds text the screen is still showing: the entry, an answer, or
 * the edited summary of a close. A skip, a cancel and a read carry none, so a
 * failure has nothing of theirs to hold on to.
 */
function holdsEditableBody(intent: PendingIntent | null): boolean {
  if (intent === null) return false;
  if (intent.kind === 'confirm') return true;
  return intent.kind === 'send' && (intent.request.intent === 'entry' || intent.request.intent === 'answer');
}

export function initialConversationState(): ConversationUiState {
  return { availability: 'unknown', snapshot: null, draft: '', summaryDraft: '', pending: null, failure: null };
}

export function classifyFailure(cause: unknown): ConversationFailure {
  if (cause instanceof ConversationContractError) {
    return { message: 'A resposta da conversa não seguiu o contrato, então nada avançou e nada foi fechado.' };
  }
  if (cause instanceof RequestError && cause.status !== undefined) {
    return { message: cause.message };
  }
  if (cause instanceof RequestError) {
    return { message: 'A conversa não chegou ao servidor. Nada foi fechado e o que você escreveu continua aqui.' };
  }
  return { message: cause instanceof Error ? cause.message : 'Erro desconhecido na conversa.' };
}

export function conversationReducer(state: ConversationUiState, action: ConversationAction): ConversationUiState {
  switch (action.type) {
    case 'reset':
      return initialConversationState();
    // The server has no conversation for this run. That only means "this flow
    // does not exist here" when none was ever read; after a successful read it
    // is a failed read, so the history stays and the stage stays closed.
    case 'resumed':
      return state.snapshot === null
        ? { ...state, availability: 'absent', pending: null, failure: null }
        : { ...state, failure: { message: 'Não foi possível reabrir a conversa desta execução: o servidor não a encontrou. Nada foi fechado e o que já foi lido continua aqui.' } };
    case 'draft':
      return { ...state, draft: action.value };
    case 'summaryDraft':
      return { ...state, summaryDraft: action.value };
    case 'begin':
      return { ...state, pending: action.intent, failure: null };
    // Giving up on the pending request instead of replaying it: the field it
    // came from opens again and the next send is a new request with a new key.
    case 'discard':
      return { ...state, pending: null, failure: null };
    case 'settled': {
      const clearsDraft = state.pending?.kind === 'send' && state.pending.request.intent !== 'cancel';
      // A summary the captain edited is theirs: only a summary they never
      // touched is replaced by the one the server just sent.
      const edited = state.snapshot !== null && state.summaryDraft !== summarySeed(state.snapshot);
      return {
        ...state,
        availability: 'available',
        snapshot: action.snapshot,
        summaryDraft: edited ? state.summaryDraft : summarySeed(action.snapshot),
        draft: clearsDraft ? '' : state.draft,
        pending: null,
        failure: null,
      };
    }
    // The request stays pending so a retry replays it exactly as it was sent;
    // what it does not do is hold the screen, which `locked` decides from the
    // body the request carries.
    case 'failed':
      return {
        ...state,
        availability: state.snapshot === null && state.pending?.kind === 'resume' ? 'unreachable' : state.availability,
        failure: action.failure,
      };
  }
}

/**
 * The captain's message that is in flight, shown once as a pending bubble. A
 * failed request is not in flight, so the error block speaks for it instead; a
 * retry reuses the same pending intent, so the bubble returns without a second
 * one being added.
 */
export function pendingMessage(state: ConversationUiState): string | null {
  if (state.failure !== null || state.pending?.kind !== 'send') return null;
  const { intent, message } = state.pending.request;
  if (intent === 'skip') return 'Pular esta pergunta';
  if (intent === 'cancel') return 'Cancelar a conversa';
  return message;
}

/**
 * What is happening right now, named for the captain and for the live region.
 * A failed request is no longer in flight, so it names nothing: the error block
 * is what speaks then.
 */
export function progressLabel(state: ConversationUiState): string | null {
  if (state.failure !== null) return null;
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
    default: return null;
  }
}

export interface ConversationAffordances {
  /** The panel has a conversation to show. */
  ready: boolean;
  /** Any request is in flight: duplicate sends are refused while it is. */
  busy: boolean;
  /**
   * A request is outstanding — in flight, or failed and still replayable. The
   * field that produced it stays read-only until the retry lands or the captain
   * discards it, so a retry can never re-send text the screen has replaced.
   */
  locked: boolean;
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
  /**
   * The failed request can be sent again exactly as it was. It is withdrawn
   * once the captain writes into the field a bodyless failure reopened: the
   * text they just typed is the action they chose, not the one that failed.
   */
  canRetry: boolean;
  /**
   * The failed request carried text from a field on screen, so dropping it and
   * editing that field again is a real way out. A read carries none.
   */
  canDiscard: boolean;
}

export function affordances(state: ConversationUiState, now: Date): ConversationAffordances {
  const snapshot = state.snapshot;
  const busy = state.pending !== null && state.failure === null;
  const locked = busy || holdsEditableBody(state.pending);
  const bodylessSend = state.pending?.kind === 'send' && !holdsEditableBody(state.pending);
  const canRetry = state.failure !== null && !(bodylessSend && state.draft.trim() !== '');
  const canDiscard = canRetry && holdsEditableBody(state.pending);
  const ready = state.availability === 'available' && snapshot !== null;
  if (!ready || snapshot === null) {
    return { ready: false, busy, locked, canSendEntry: false, canAnswer: false, canSkip: false, canCancel: false, canConfirm: false, asking: false, summaryOpen: false, atLimit: false, closed: false, canRetry, canDiscard };
  }
  const closed = briefingClosed(snapshot);
  const halted = snapshot.state === 'cancelled' || snapshot.state === 'failed';
  const atLimit = limitReached(snapshot, now) && !closed && !halted;
  const typed = state.draft.trim() !== '';
  const asking = !closed && snapshot.state === 'question' && snapshot.question !== undefined && !atLimit;
  // Nothing to close a briefing with is not an exit: a halted conversation with
  // no persisted text says so rather than offering an empty close.
  const closable = snapshot.summary !== '' || snapshot.briefing !== '';
  // A `final` snapshot the server did not stamp `closedAt` on is a summary that
  // was consolidated and not yet confirmed, so it closes the same way.
  const summaryOpen = !closed && closable && (snapshot.state === 'confirmation' || snapshot.state === 'final' || atLimit || halted);
  return {
    ready: true,
    busy,
    locked,
    canSendEntry: !locked && !atLimit && snapshot.state === 'entry' && typed,
    canAnswer: !locked && asking && typed,
    canSkip: !locked && asking,
    canCancel: !locked && !closed && !halted,
    canConfirm: !locked && summaryOpen && state.summaryDraft.trim() !== '',
    asking,
    summaryOpen,
    atLimit,
    closed,
    canRetry,
    canDiscard,
  };
}
