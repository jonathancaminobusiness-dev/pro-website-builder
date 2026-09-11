import { z } from 'zod';
import { IDENTITY_BRIEFING_MAX_LENGTH } from './briefing.js';

/**
 * The briefing conversation: a short, persisted exchange that happens *before*
 * the identity stage and produces the execution's final briefing.
 *
 * This module is the single contract the Studio and the server share, so the
 * two can never drift: the states and their legal transitions, the closed
 * typed turn a model may answer with, the size limits, the request bodies and
 * the endpoint paths all live here. It is a preparation layer, not a gate and
 * not a preview generator: nothing here may carry a rendered document, and
 * `findVisualOutput` is the rule that says so in code rather than in prose.
 */

// ---------------------------------------------------------------- states

export const BRIEFING_CONVERSATION_STATES = ['entry', 'recommendation', 'question', 'confirmation', 'final', 'cancelled', 'failed'] as const;
export const briefingConversationStateSchema = z.enum(BRIEFING_CONVERSATION_STATES);
export type BriefingConversationState = z.infer<typeof briefingConversationStateSchema>;

/**
 * Every legal move of the conversation, and nothing else.
 *
 * Two returns are deliberate rather than accidental: `question ->
 * recommendation` is what an answer does, because the model re-reads the brief
 * before it asks again, and `confirmation -> question` is what a captain asking
 * for an adjustment does. `entry -> confirmation` exists because a model with
 * enough context may skip the questions, and because the deterministic fallback
 * has to be able to offer a summary even when the very first turn fails.
 *
 * `final` is never a move a model makes: only the captain's confirmation closes
 * the briefing, which is why it appears solely as an exit of `confirmation` and
 * of `failed`. `cancelled` and `failed` end the current conversation without
 * touching the execution or a briefing the captain already confirmed, and the
 * one exit `failed` keeps is the captain closing the deterministic summary that
 * safe mode offered.
 */
export const BRIEFING_CONVERSATION_TRANSITIONS: Readonly<Record<BriefingConversationState, readonly BriefingConversationState[]>> = Object.freeze({
  entry: ['recommendation', 'confirmation', 'cancelled', 'failed'],
  recommendation: ['question', 'confirmation', 'cancelled', 'failed'],
  question: ['recommendation', 'confirmation', 'cancelled', 'failed'],
  confirmation: ['question', 'final', 'cancelled', 'failed'],
  final: [],
  cancelled: [],
  failed: ['final'],
});

export function canBriefingConversationTransition(from: BriefingConversationState, to: BriefingConversationState): boolean {
  return BRIEFING_CONVERSATION_TRANSITIONS[from].includes(to);
}

/** The states a captain may still send a message from; everything else is closed to model turns. */
export function canSendBriefingMessage(state: BriefingConversationState): boolean {
  return state === 'entry' || state === 'recommendation' || state === 'question' || state === 'confirmation';
}

/**
 * The states a captain may close the briefing from. `failed` is included on
 * purpose: a model failure must never take away the captain's ability to close
 * the briefing from what they have already said. `final` is included because a
 * later edit opens the next revision rather than rewriting the one already
 * signed.
 */
export function canConfirmBriefing(state: BriefingConversationState): boolean {
  return state === 'confirmation' || state === 'failed' || state === 'final';
}

// ---------------------------------------------------------------- limits

/** How many questions the model may ask before the conversation must offer a summary instead. */
export const BRIEFING_CONVERSATION_MAX_QUESTIONS = 6;
/** How long one model turn may take before the conversation falls back to a deterministic summary. */
export const BRIEFING_CONVERSATION_TURN_TIMEOUT_MS = 60_000;
/** One correction re-invocation, then the safe deterministic fallback. */
export const BRIEFING_CONVERSATION_MAX_ATTEMPTS = 2;
/** The captain's message shares the briefing limit, because it becomes part of the briefing. */
export const BRIEFING_MESSAGE_MAX_LENGTH = IDENTITY_BRIEFING_MAX_LENGTH;
export const BRIEFING_SUMMARY_MAX_LENGTH = IDENTITY_BRIEFING_MAX_LENGTH;
export const BRIEFING_TURN_MESSAGE_MAX_LENGTH = 2_000;
export const BRIEFING_TURN_LIST_MAX_ITEMS = 8;
export const BRIEFING_TURN_ITEM_MAX_LENGTH = 280;
export const BRIEFING_CONVERSATION_MAX_MESSAGES = 60;
export const BRIEFING_IDEMPOTENCY_KEY_MAX_LENGTH = 200;
/** The plan asks for exactly three conceptual directions, never two and never four. */
export const BRIEFING_CONCEPTUAL_DIRECTIONS = 3;

// ------------------------------------------------------- visual refusal

interface VisualOutputRule { readonly id: string; readonly pattern: RegExp; readonly why: string }

/**
 * The product boundary written as a predicate. A conceptual direction may say
 * "verde folha com areia para transmitir cuidado contínuo"; it may not ship a
 * hex value, a token path, markup, a stylesheet declaration, a code fence, an
 * image or a link. Gate 1 owns the visual work, and this is what keeps the
 * conversation from quietly becoming a preview generator.
 */
export const BRIEFING_VISUAL_OUTPUT_RULES: readonly VisualOutputRule[] = Object.freeze([
  { id: 'markup', pattern: /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/i, why: 'A conversa de briefing não escreve HTML nem JSX.' },
  { id: 'code-fence', pattern: /```/, why: 'A conversa de briefing não devolve blocos de código.' },
  { id: 'hex-color', pattern: /#[0-9a-f]{3}(?:[0-9a-f]{3}(?:[0-9a-f]{2})?)?\b/i, why: 'A paleta é descrita por função e clima, nunca por valor de cor.' },
  { id: 'css-declaration', pattern: /(?:^|[\s;{])(?:color|background(?:-color)?|font-family|font-size)\s*:/i, why: 'A conversa de briefing não escreve CSS.' },
  { id: 'token-path', pattern: /\b(?:color|font|space|radius|size)\.[a-z][a-z0-9]*\.[a-z0-9]/i, why: 'Tokens pertencem à etapa de identidade, não ao briefing.' },
  { id: 'data-uri', pattern: /data:image\//i, why: 'A conversa de briefing não devolve imagens.' },
  { id: 'image-file', pattern: /\.(?:png|jpe?g|svg|webp|gif|avif)\b/i, why: 'A conversa de briefing não devolve arquivos de imagem.' },
  { id: 'link', pattern: /https?:\/\//i, why: 'A conversa de briefing não referencia site, mockup ou preview.' },
]);

/** The ids of every visual-output rule the text breaks, in declaration order. */
export function findVisualOutput(text: string): string[] {
  return BRIEFING_VISUAL_OUTPUT_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id);
}

export function visualOutputReason(ids: readonly string[]): string {
  const reasons = BRIEFING_VISUAL_OUTPUT_RULES.filter((rule) => ids.includes(rule.id)).map((rule) => rule.why);
  return reasons.join(' ');
}

// ------------------------------------------------------------- the turn

const sentence = (max: number): z.ZodString => z.string().trim().min(1).max(max);

export const briefingConversationIntentSchema = z.enum(['recommendation', 'question', 'confirmation', 'final']);
export type BriefingConversationIntent = z.infer<typeof briefingConversationIntentSchema>;

/** One question, with the reason an answer would change the identity. Never more than one per turn. */
export const briefingQuestionSchema = z.object({
  text: sentence(BRIEFING_TURN_ITEM_MAX_LENGTH),
  why: sentence(BRIEFING_TURN_ITEM_MAX_LENGTH),
  options: z.array(sentence(120)).max(4).default([]),
}).strict();
export type BriefingQuestion = z.infer<typeof briefingQuestionSchema>;

/** A gap the briefing does not close, and what it would change if it did. */
export const briefingGapSchema = z.object({
  gap: sentence(BRIEFING_TURN_ITEM_MAX_LENGTH),
  impact: sentence(BRIEFING_TURN_ITEM_MAX_LENGTH),
}).strict();
export type BriefingGap = z.infer<typeof briefingGapSchema>;

/** A conceptual direction: text a captain reads, never a document a renderer draws. */
export const conceptualDirectionSchema = z.object({
  id: z.string().regex(/^dir-[a-z0-9][a-z0-9-]{0,39}$/, 'Uma direção conceitual precisa de um id no formato dir-<slug>.'),
  label: sentence(80),
  positioning: sentence(400),
  tone: sentence(400),
  visualLanguage: sentence(400),
  palette: sentence(400),
  typography: sentence(400),
  composition: sentence(400),
  applications: z.array(sentence(160)).min(1).max(6),
}).strict();
export type ConceptualDirection = z.infer<typeof conceptualDirectionSchema>;

function turnTexts(turn: { message: string; question?: BriefingQuestion | undefined; facts: string[]; hypotheses: string[]; unknowns: BriefingGap[]; summary?: string | undefined; directions?: ConceptualDirection[] | undefined }): string[] {
  return [
    turn.message,
    ...(turn.question ? [turn.question.text, turn.question.why, ...turn.question.options] : []),
    ...turn.facts,
    ...turn.hypotheses,
    ...turn.unknowns.flatMap((gap) => [gap.gap, gap.impact]),
    ...(turn.summary ? [turn.summary] : []),
    ...(turn.directions ?? []).flatMap((direction) => [direction.label, direction.positioning, direction.tone, direction.visualLanguage, direction.palette, direction.typography, direction.composition, ...direction.applications]),
  ];
}

/**
 * The closed answer a model may give. `intent` and `nextState` must agree:
 * carrying both and requiring them equal is the cheapest check that catches a
 * model which narrated one move and asked for another.
 */
export const briefingConversationTurnSchema = z.object({
  message: sentence(BRIEFING_TURN_MESSAGE_MAX_LENGTH),
  intent: briefingConversationIntentSchema,
  question: briefingQuestionSchema.optional(),
  facts: z.array(sentence(BRIEFING_TURN_ITEM_MAX_LENGTH)).max(BRIEFING_TURN_LIST_MAX_ITEMS).default([]),
  hypotheses: z.array(sentence(BRIEFING_TURN_ITEM_MAX_LENGTH)).max(BRIEFING_TURN_LIST_MAX_ITEMS).default([]),
  unknowns: z.array(briefingGapSchema).max(BRIEFING_TURN_LIST_MAX_ITEMS).default([]),
  summary: sentence(BRIEFING_SUMMARY_MAX_LENGTH).optional(),
  directions: z.array(conceptualDirectionSchema).length(BRIEFING_CONCEPTUAL_DIRECTIONS).optional(),
  nextState: briefingConversationStateSchema,
}).strict().superRefine((turn, context) => {
  if (turn.nextState !== turn.intent) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['nextState'], message: `A intenção ${turn.intent} exige nextState ${turn.intent}.` });
  }
  if (turn.intent === 'question' && !turn.question) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['question'], message: 'Uma pergunta precisa do campo question com o texto e o motivo.' });
  }
  if (turn.intent !== 'question' && turn.question) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['question'], message: 'Só uma intenção de pergunta pode carregar question.' });
  }
  if ((turn.intent === 'confirmation' || turn.intent === 'final') && !turn.summary) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['summary'], message: 'Confirmação e fechamento precisam de um resumo editável.' });
  }
  if (turn.intent === 'final' && !turn.directions) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['directions'], message: `O fechamento precisa de ${BRIEFING_CONCEPTUAL_DIRECTIONS} direções conceituais.` });
  }
  if (turn.intent !== 'final' && turn.directions) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['directions'], message: 'Direções conceituais só existem no fechamento da conversa.' });
  }
  for (const [index, text] of turnTexts(turn).entries()) {
    const violations = findVisualOutput(text);
    if (violations.length === 0) continue;
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['message', index], message: `Saída visual recusada (${violations.join(', ')}). ${visualOutputReason(violations)}` });
  }
});
export type BriefingConversationTurn = z.infer<typeof briefingConversationTurnSchema>;

// ------------------------------------------------------- the transcript

export const briefingConversationAuthorSchema = z.enum(['captain', 'studio', 'system']);
export type BriefingConversationAuthor = z.infer<typeof briefingConversationAuthorSchema>;

export const briefingConversationMessageSchema = z.object({
  id: z.string().min(1),
  /** Position in the transcript, so a client can order and a retry can be recognised. */
  index: z.number().int().nonnegative(),
  author: briefingConversationAuthorSchema,
  text: z.string().min(1),
  createdAt: z.string().min(1),
  /** The conversation state this message left behind. */
  state: briefingConversationStateSchema,
  turn: briefingConversationTurnSchema.optional(),
  /** True when this message is the deterministic safe answer rather than a model's. */
  fallback: z.boolean().default(false),
}).strict();
export type BriefingConversationMessage = z.infer<typeof briefingConversationMessageSchema>;

export const briefingAnsweredQuestionSchema = z.object({
  index: z.number().int().nonnegative(),
  question: z.string().min(1),
  why: z.string().min(1),
  answer: z.string().min(1).optional(),
  skipped: z.boolean().default(false),
}).strict();
export type BriefingAnsweredQuestion = z.infer<typeof briefingAnsweredQuestionSchema>;

/**
 * A confirmed briefing is a stable record. Editing the briefing later opens the
 * next revision; it never rewrites the one the captain already signed.
 */
export const briefingConfirmationSchema = z.object({
  revision: z.number().int().positive(),
  briefing: z.string().min(1),
  openGaps: z.array(briefingGapSchema).default([]),
  confirmedAt: z.string().min(1),
  /** How much transcript the captain was looking at when they confirmed. */
  messageCount: z.number().int().nonnegative(),
}).strict();
export type BriefingConfirmation = z.infer<typeof briefingConfirmationSchema>;

export const briefingConversationErrorSchema = z.object({ code: z.string().min(1), message: z.string().min(1) }).strict();
export type BriefingConversationError = z.infer<typeof briefingConversationErrorSchema>;

/** Everything the GET route returns and the execution persists, in one shape. */
export const briefingConversationSnapshotSchema = z.object({
  runId: z.string().min(1),
  state: briefingConversationStateSchema,
  /** The captain's first text exactly as it was typed. */
  originalText: z.string().default(''),
  /** The same text after the server's normalization; this is what the model reads. */
  normalizedText: z.string().default(''),
  messages: z.array(briefingConversationMessageSchema).default([]),
  summary: z.string().optional(),
  openGaps: z.array(briefingGapSchema).default([]),
  askedQuestions: z.array(briefingAnsweredQuestionSchema).default([]),
  /** Model questions asked so far, against BRIEFING_CONVERSATION_MAX_QUESTIONS. */
  questionCount: z.number().int().nonnegative().default(0),
  /** Model attempts spent on the last turn: 1 is a clean answer, 2 means a correction was needed. */
  attempt: z.number().int().nonnegative().default(0),
  error: briefingConversationErrorSchema.optional(),
  /** True while the latest answer is the deterministic safe summary. */
  fallback: z.boolean().default(false),
  /** True once the conversation may no longer ask, so only a summary is offered. */
  limitReached: z.boolean().default(false),
  confirmations: z.array(briefingConfirmationSchema).default([]),
  directions: z.array(conceptualDirectionSchema).default([]),
  /** The briefing the execution carries once the captain confirmed, if they have. */
  briefing: z.string().optional(),
  /**
   * The idempotency keys this conversation has already spent a turn on. It is
   * persisted rather than held in memory because the retry a caller makes after
   * a timeout is exactly the case a restart would otherwise duplicate.
   */
  appliedKeys: z.array(z.string()).default([]),
}).strict();
export type BriefingConversationSnapshot = z.infer<typeof briefingConversationSnapshotSchema>;

// ----------------------------------------------------------- the routes

export const BRIEFING_CONVERSATION_ROUTE = '/api/identity/runs/:runId/conversation';
export const BRIEFING_CONVERSATION_CONFIRM_ROUTE = '/api/identity/runs/:runId/conversation/confirm';

export function briefingConversationPath(runId: string): string {
  return `/api/identity/runs/${encodeURIComponent(runId)}/conversation`;
}

export function briefingConversationConfirmPath(runId: string): string {
  return `${briefingConversationPath(runId)}/confirm`;
}

/**
 * What a captain can do with one message. `answer` and `correct` both carry
 * text; `skip` declines the open question without pretending it was answered;
 * `cancel` stops the conversation and leaves the execution reopenable.
 */
export const briefingMessageActionSchema = z.enum(['answer', 'correct', 'skip', 'cancel']);
export type BriefingMessageAction = z.infer<typeof briefingMessageActionSchema>;

/**
 * The idempotency key is required, not optional: a retry after a timeout is the
 * normal case for a 60-second model turn, and a turn that can be duplicated is
 * a turn that will be.
 */
export const briefingConversationRequestSchema = z.object({
  message: z.string().max(BRIEFING_MESSAGE_MAX_LENGTH).optional(),
  action: briefingMessageActionSchema.default('answer'),
  idempotencyKey: z.string().trim().min(1).max(BRIEFING_IDEMPOTENCY_KEY_MAX_LENGTH),
}).strict();
export type BriefingConversationRequest = z.infer<typeof briefingConversationRequestSchema>;

export const briefingConfirmRequestSchema = z.object({
  /** The edited summary the captain is signing; it becomes the execution's briefing. */
  briefing: z.string().max(BRIEFING_SUMMARY_MAX_LENGTH),
  idempotencyKey: z.string().trim().min(1).max(BRIEFING_IDEMPOTENCY_KEY_MAX_LENGTH),
}).strict();
export type BriefingConfirmRequest = z.infer<typeof briefingConfirmRequestSchema>;
