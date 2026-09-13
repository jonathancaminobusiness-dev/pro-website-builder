/**
 * The Studio's one door onto the briefing conversation contract.
 *
 * The wire shapes, the states, the limits and the endpoint paths all come from
 * `@pwb/domain/conversation`, which is the single contract the server and the
 * Studio share. Nothing here re-declares one of them: this module parses what
 * the API answered with the shared schema and adapts it into the small view
 * model the panel reads — one turn per transcript entry, the single open
 * question, the consolidated summary, the counter and its ceiling.
 *
 * The adaptation is deliberately the only thing that lives here. A screen needs
 * a stable key per bubble and an id for the question it is answering; the
 * transcript numbers its entries instead, so those ids are derived from that
 * number and from nothing the Studio invented.
 */
import {
  BRIEFING_CONVERSATION_MAX_QUESTIONS,
  BRIEFING_SUMMARY_MAX_LENGTH,
  briefingConversationConfirmPath,
  briefingConversationPath,
  briefingConversationSnapshotSchema,
  type BriefingConfirmRequest,
  type BriefingConversationIntent,
  type BriefingConversationMessage,
  type BriefingConversationRequest,
  type BriefingConversationSnapshot,
  type BriefingConversationState,
  type ConceptualDirection,
} from '@pwb/domain/conversation';

export type ConversationState = BriefingConversationState;
export type ConversationIntent = BriefingConversationIntent;
export type ConversationDirection = ConceptualDirection;

/** The one question on screen. `why` is required: a question that cannot say what it changes is not asked. */
export interface ConversationQuestion {
  id: string;
  prompt: string;
  why: string;
  options: string[];
}

/**
 * One entry of the transcript as the panel shows it. `role` is what the bubble
 * is styled and labelled by, so the server's `system` notes — a cancellation, a
 * failure the captain must read — are the Studio speaking.
 */
export interface ConversationTurn {
  id: string;
  role: 'captain' | 'studio';
  /** The conversation state this entry left behind: what labels a captain bubble. */
  state: ConversationState;
  /** The move the model made, when a model made one. A system note carries none. */
  intent?: ConversationIntent;
  message: string;
  question?: ConversationQuestion;
  facts: string[];
  hypotheses: string[];
  /** A declared gap and what it would change, in one line the panel can list. */
  unknowns: string[];
  summary?: string;
}

export interface ConversationLimits {
  /** How many questions the conversation may ask, from the shared contract. */
  questionLimit: number;
  /** The briefing length the API accepts, so the editor and the chat agree on one number. */
  briefingMaxLength: number;
}

export interface ConversationSnapshot {
  runId: string;
  state: ConversationState;
  /** The captain's first text exactly as it was typed, as the execution persisted it. */
  briefing: string;
  turns: ConversationTurn[];
  /** The single current question, present only while the conversation is asking one. */
  question?: ConversationQuestion;
  /** The consolidated summary the captain edits and confirms. */
  summary: string;
  /** Questions asked so far, counted by the server against `limits.questionLimit`. */
  questionCount: number;
  limits: ConversationLimits;
  /** The server's own verdict that the conversation may no longer ask. */
  limitReached: boolean;
  directions: ConversationDirection[];
  /** True once the captain signed a briefing: at least one confirmation is on record. */
  closed: boolean;
  /** Why the server put the conversation in `failed`, or what it could not finish. */
  error?: string;
}

/** What the captain can do with one message, in the Studio's words. */
export type ConversationSendIntent = 'entry' | 'answer' | 'correct' | 'skip' | 'cancel';

export interface ConversationSendRequest {
  /** Re-sent verbatim on a retry, so the server folds the repeat into the same turn. */
  idempotencyKey: string;
  intent: ConversationSendIntent;
  message: string;
}

export interface ConversationConfirmRequest {
  idempotencyKey: string;
  /** The summary as the captain edited it; confirming is what closes the briefing. */
  summary: string;
}

/** The response did not match the contract. The screen explains this and offers another attempt. */
export class ConversationContractError extends Error {
  constructor(readonly detail: string) {
    super('A resposta da conversa não seguiu o contrato.');
    this.name = 'ConversationContractError';
  }
}

export const conversationPath = briefingConversationPath;
export const conversationConfirmPath = briefingConversationConfirmPath;

/**
 * The captain's move as the request body the contract defines. `entry` is an
 * answer like any other — it is the Studio that knows the field it came from —
 * and a move that carries no text sends none rather than an empty string.
 */
export function conversationSendBody(request: ConversationSendRequest): BriefingConversationRequest {
  const action = request.intent === 'entry' ? 'answer' : request.intent;
  const message = request.message.trim();
  return { action, idempotencyKey: request.idempotencyKey, ...(message === '' ? {} : { message }) };
}

export function conversationConfirmBody(request: ConversationConfirmRequest): BriefingConfirmRequest {
  return { briefing: request.summary, idempotencyKey: request.idempotencyKey };
}

/** The transcript numbers its entries, so the question a bubble asks is named by that number. */
function questionId(index: number): string {
  return `pergunta-${index}`;
}

function adaptQuestion(message: BriefingConversationMessage): ConversationQuestion | undefined {
  const question = message.turn?.question;
  if (!question) return undefined;
  return { id: questionId(message.index), prompt: question.text, why: question.why, options: [...question.options] };
}

function adaptTurn(message: BriefingConversationMessage): ConversationTurn {
  const turn = message.turn;
  const question = adaptQuestion(message);
  return {
    id: message.id,
    role: message.author === 'captain' ? 'captain' : 'studio',
    state: message.state,
    ...(turn ? { intent: turn.intent } : {}),
    message: message.text,
    ...(question ? { question } : {}),
    facts: turn ? [...turn.facts] : [],
    hypotheses: turn ? [...turn.hypotheses] : [],
    unknowns: turn ? turn.unknowns.map((gap) => `${gap.gap} — ${gap.impact}`) : [],
    ...(turn?.summary === undefined ? {} : { summary: turn.summary }),
  };
}

/**
 * The question that is actually open: the last one the conversation asked,
 * offered only while the conversation is still in `question`. A state that
 * moved on has answered it, and the panel must not go on showing a field for a
 * question the server no longer holds.
 */
function openQuestion(snapshot: BriefingConversationSnapshot): ConversationQuestion | undefined {
  if (snapshot.state !== 'question') return undefined;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message === undefined) continue;
    const question = adaptQuestion(message);
    if (question) return question;
  }
  return undefined;
}

/**
 * Turns whatever the API answered into a snapshot, or refuses it. A refusal is
 * the screen's "resposta inválida" state: the conversation does not advance and
 * the captain is offered another attempt with the draft still in hand.
 */
export function parseConversationSnapshot(value: unknown): ConversationSnapshot {
  const parsed = briefingConversationSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConversationContractError(issue ? `${issue.path.join('.') || 'conversation'}: ${issue.message}` : 'conversation');
  }
  const snapshot = parsed.data;
  const question = openQuestion(snapshot);
  return {
    runId: snapshot.runId,
    state: snapshot.state,
    briefing: snapshot.originalText,
    turns: snapshot.messages.map(adaptTurn),
    ...(question ? { question } : {}),
    summary: snapshot.summary ?? '',
    questionCount: snapshot.questionCount,
    limits: { questionLimit: BRIEFING_CONVERSATION_MAX_QUESTIONS, briefingMaxLength: BRIEFING_SUMMARY_MAX_LENGTH },
    limitReached: snapshot.limitReached || snapshot.questionCount >= BRIEFING_CONVERSATION_MAX_QUESTIONS,
    directions: snapshot.directions.map((direction) => ({ ...direction, applications: [...direction.applications] })),
    closed: snapshot.confirmations.length > 0,
    ...(snapshot.error ? { error: snapshot.error.message } : {}),
  };
}

/** The ceiling, read from the contract the server answered with rather than from a constant in the interface. */
export function atQuestionLimit(snapshot: ConversationSnapshot): boolean {
  return snapshot.questionCount >= snapshot.limits.questionLimit;
}

/** A conversation that reached the ceiling stops asking and offers the editable summary and a manual close. */
export function limitReached(snapshot: ConversationSnapshot): boolean {
  return snapshot.limitReached;
}

/** The briefing is closed: the identity stage may run and the directions are readable. */
export function briefingClosed(snapshot: ConversationSnapshot): boolean {
  return snapshot.closed;
}

/**
 * Which moves the conversation still admits, decided by the shared contract
 * rather than by a list the panel keeps: a state that may take a message, and a
 * state the captain may close the briefing from.
 */
export { canConfirmBriefing, canSendBriefingMessage } from '@pwb/domain/conversation';
