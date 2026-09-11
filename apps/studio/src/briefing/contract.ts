/**
 * Local mirror of the briefing conversation contract published by the server
 * slice (`fm/pwb-chat-core-k9`). Every name here — the endpoint paths, the
 * seven states and the shape of a turn — is the one that branch exposes, so
 * swapping this module for the shared package is a single import change in
 * `client.ts`. Nothing else in the Studio imports the wire shapes directly.
 *
 * The counter and the limits are read from what the server sent. The Studio
 * never keeps a number of its own for them: a ceiling the API moved has to move
 * on screen in the same deploy.
 */

export const CONVERSATION_STATES = ['entry', 'recommendation', 'question', 'confirmation', 'final', 'cancelled', 'failed'] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const CONVERSATION_INTENTS = ['entry', 'recommendation', 'question', 'answer', 'skip', 'confirmation', 'final', 'cancel'] as const;
export type ConversationIntent = (typeof CONVERSATION_INTENTS)[number];

/** The one question on screen. `why` is required: a question that cannot say what it changes is not asked. */
export interface ConversationQuestion {
  id: string;
  prompt: string;
  why: string;
  options?: string[];
}

export interface ConversationTurn {
  id: string;
  role: 'captain' | 'studio';
  message: string;
  intent: ConversationIntent;
  question?: ConversationQuestion;
  facts: string[];
  hypotheses: string[];
  unknowns: string[];
  summary?: string;
  nextState: ConversationState;
}

/** A conceptual direction: text the captain reads. It carries no image, token or preview reference by construction. */
export interface ConversationDirection {
  id: string;
  label: string;
  thesis: string;
  positioning: string;
  tone: string;
  composition: string;
  typography: string;
}

export interface ConversationLimits {
  /** Message ceiling for the whole conversation, counted the way `messageCount` counts. */
  messageLimit: number;
  /** The briefing length the API accepts, so the editor and the chat agree on one number. */
  briefingMaxLength: number;
  /** When the conversation window closes, if the server set one. */
  expiresAt?: string;
}

export interface ConversationSnapshot {
  runId: string;
  state: ConversationState;
  /** The captain's text as persisted on the execution. */
  briefing: string;
  turns: ConversationTurn[];
  /** The single current question, present only while the conversation is asking one. */
  question?: ConversationQuestion;
  /** The consolidated summary the captain edits and confirms. */
  summary: string;
  messageCount: number;
  limits: ConversationLimits;
  directions: ConversationDirection[];
  /** Set once the captain closed the briefing. */
  closedAt?: string;
  /** Why the server put the conversation in `failed`, when it did. */
  error?: string;
}

export interface ConversationSendRequest {
  /** Re-sent verbatim on a retry, so the server folds the repeat into the same turn. */
  idempotencyKey: string;
  intent: Extract<ConversationIntent, 'entry' | 'answer' | 'skip' | 'cancel'>;
  message: string;
  /** The question the message answers, when it answers one. */
  questionId?: string;
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

export function conversationPath(runId: string): string {
  return `/api/identity/runs/${encodeURIComponent(runId)}/conversation`;
}

export function conversationConfirmPath(runId: string): string {
  return `${conversationPath(runId)}/confirm`;
}

function record(value: unknown, detail: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConversationContractError(detail);
  return value as Record<string, unknown>;
}

function text(value: unknown, detail: string): string {
  if (typeof value !== 'string') throw new ConversationContractError(detail);
  return value;
}

function optionalText(value: unknown, detail: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, detail);
}

function textList(value: unknown, detail: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ConversationContractError(detail);
  return value.map((item) => text(item, detail));
}

function count(value: unknown, detail: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ConversationContractError(detail);
  return value;
}

function member<T extends string>(value: unknown, allowed: readonly T[], detail: string): T {
  const candidate = text(value, detail);
  if (!(allowed as readonly string[]).includes(candidate)) throw new ConversationContractError(detail);
  return candidate as T;
}

function parseQuestion(value: unknown, detail: string): ConversationQuestion {
  const source = record(value, detail);
  const options = source.options === undefined || source.options === null ? undefined : textList(source.options, detail);
  return {
    id: text(source.id, detail),
    prompt: text(source.prompt, detail),
    why: text(source.why, detail),
    ...(options && options.length > 0 ? { options } : {}),
  };
}

function parseTurn(value: unknown, position: number): ConversationTurn {
  const detail = `turns[${position}]`;
  const source = record(value, detail);
  return {
    id: text(source.id, detail),
    role: member(source.role, ['captain', 'studio'] as const, detail),
    message: text(source.message, detail),
    intent: member(source.intent, CONVERSATION_INTENTS, detail),
    ...(source.question === undefined || source.question === null ? {} : { question: parseQuestion(source.question, detail) }),
    facts: textList(source.facts, detail),
    hypotheses: textList(source.hypotheses, detail),
    unknowns: textList(source.unknowns, detail),
    ...(source.summary === undefined || source.summary === null ? {} : { summary: text(source.summary, detail) }),
    nextState: member(source.nextState, CONVERSATION_STATES, detail),
  };
}

function parseDirection(value: unknown, position: number): ConversationDirection {
  const detail = `directions[${position}]`;
  const source = record(value, detail);
  return {
    id: text(source.id, detail),
    label: text(source.label, detail),
    thesis: text(source.thesis, detail),
    positioning: text(source.positioning, detail),
    tone: text(source.tone, detail),
    composition: text(source.composition, detail),
    typography: text(source.typography, detail),
  };
}

function parseLimits(value: unknown): ConversationLimits {
  const source = record(value, 'limits');
  const expiresAt = optionalText(source.expiresAt, 'limits.expiresAt');
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new ConversationContractError('limits.expiresAt');
  return {
    messageLimit: count(source.messageLimit, 'limits.messageLimit'),
    briefingMaxLength: count(source.briefingMaxLength, 'limits.briefingMaxLength'),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * Turns whatever the API answered into a snapshot, or refuses it. A refusal is
 * the screen's "resposta inválida" state: the conversation does not advance and
 * the captain is offered another attempt with the draft still in hand.
 */
export function parseConversationSnapshot(value: unknown): ConversationSnapshot {
  const source = record(value, 'conversation');
  const turns = Array.isArray(source.turns) ? source.turns.map(parseTurn) : (() => { throw new ConversationContractError('turns'); })();
  const directions = source.directions === undefined || source.directions === null
    ? []
    : Array.isArray(source.directions) ? source.directions.map(parseDirection) : (() => { throw new ConversationContractError('directions'); })();
  const closedAt = optionalText(source.closedAt, 'closedAt');
  const error = optionalText(source.error, 'error');
  return {
    runId: text(source.runId, 'runId'),
    state: member(source.state, CONVERSATION_STATES, 'state'),
    briefing: text(source.briefing, 'briefing'),
    turns,
    ...(source.question === undefined || source.question === null ? {} : { question: parseQuestion(source.question, 'question') }),
    summary: typeof source.summary === 'string' ? source.summary : '',
    messageCount: count(source.messageCount, 'messageCount'),
    limits: parseLimits(source.limits),
    directions,
    ...(closedAt ? { closedAt } : {}),
    ...(error ? { error } : {}),
  };
}

/** The message ceiling, read from the contract the server sent rather than from a constant in the interface. */
export function atMessageLimit(snapshot: ConversationSnapshot): boolean {
  return snapshot.messageCount >= snapshot.limits.messageLimit;
}

/** The time ceiling. A conversation with no `expiresAt` has none; a ceiling that arrives unreadable was already refused by the parser. */
export function pastTimeLimit(snapshot: ConversationSnapshot, now: Date): boolean {
  if (!snapshot.limits.expiresAt) return false;
  return now.getTime() >= Date.parse(snapshot.limits.expiresAt);
}

/** A conversation that reached either ceiling stops asking and offers the editable summary and a manual close. */
export function limitReached(snapshot: ConversationSnapshot, now: Date): boolean {
  return atMessageLimit(snapshot) || pastTimeLimit(snapshot, now);
}

/** The briefing is closed: the identity stage may run and the directions are readable. */
export function briefingClosed(snapshot: ConversationSnapshot): boolean {
  return snapshot.state === 'final' && snapshot.closedAt !== undefined;
}
