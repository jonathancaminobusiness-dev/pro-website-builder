import { randomUUID } from 'node:crypto';
import {
  BRIEFING_CONVERSATION_MAX_ATTEMPTS,
  BRIEFING_CONVERSATION_MAX_QUESTIONS,
  BRIEFING_CONVERSATION_TURN_TIMEOUT_MS,
  BRIEFING_MESSAGE_MAX_LENGTH,
  BRIEFING_SUMMARY_MAX_LENGTH,
  briefingConversationSnapshotSchema,
  briefingConversationTurnSchema,
  briefingTurnNextStates,
  canConfirmBriefing,
  canSendBriefingMessage,
  findTurnVisualOutput,
  hashJson,
  visualOutputReason,
  type AgentResult,
  type AgentTask,
  type BriefingAnsweredQuestion,
  type BriefingConfirmation,
  type BriefingConversationError,
  type BriefingConversationMessage,
  type BriefingConversationSnapshot,
  type BriefingConversationState,
  type BriefingConversationTurn,
  type BriefingGap,
  type BriefingMessageAction,
  type ConceptualDirection,
} from '@pwb/domain';
import type { ModelProvider } from '@pwb/providers';
import { BriefingValidationError, normalizeIdentityBriefing } from './identity-briefing.js';
import { briefingConversationPrompt, type BriefingTurnContext } from './identity-conversation-prompt.js';

export const BRIEFING_CONVERSATION_PROMPT_VERSION = 'briefing-conversation-1';
/** How many transcript entries one turn may carry; older ones are already folded into the summary and the answered questions. */
const HISTORY_WINDOW = 12;
/** Idempotency keys kept per execution. A conversation is short; this is generous and bounded. */
const KEY_MEMORY = 100;

/** A refusal the captain can act on, answered as 400/409 rather than as a fault. */
export class ConversationError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) {
    super(message);
    this.name = 'ConversationError';
  }
}

/** Why a model turn did not produce a usable answer, already worded for the captain. */
interface TurnFailure { code: string; message: string }

export interface BriefingConversationOptions {
  runId: string;
  provider: ModelProvider;
  /** Writes the conversation onto the execution after every change that must survive a restart. */
  persist: (snapshot: BriefingConversationSnapshot) => Promise<void>;
  /** Called with the briefing a confirmation produced, so the execution carries it into the identity stage. */
  onConfirmed?: (briefing: string, revision: number) => Promise<void> | void;
  /**
   * The briefing the execution carries, read at the moment a turn needs it. The
   * plan creates the execution from the captain's first text, so the opening
   * turn may carry no message at all and start from that text instead of asking
   * the captain to type it twice — and because it is read rather than captured,
   * a restarted process resolves it from the execution like everything else.
   */
  initialText?: () => string | undefined;
  timeoutMs?: number;
  maxQuestions?: number;
  now?: () => Date;
  newId?: () => string;
}

interface ConversationState {
  state: BriefingConversationState;
  originalText: string;
  normalizedText: string;
  messages: BriefingConversationMessage[];
  summary?: string;
  openGaps: BriefingGap[];
  askedQuestions: BriefingAnsweredQuestion[];
  questionCount: number;
  attempt: number;
  error?: BriefingConversationError;
  fallback: boolean;
  confirmations: BriefingConfirmation[];
  directions: ConceptualDirection[];
  briefing?: string;
  appliedKeys: string[];
}

function emptyState(): ConversationState {
  return { state: 'entry', originalText: '', normalizedText: '', messages: [], openGaps: [], askedQuestions: [], questionCount: 0, attempt: 0, fallback: false, confirmations: [], directions: [], appliedKeys: [] };
}

/**
 * The briefing conversation of one execution: the state machine, its
 * transcript, the model turn and the deterministic safe mode that catches it.
 *
 * Three properties are the reason this is a class rather than a handler. It is
 * the only thing that moves the state, so every transition is checked in one
 * place. It writes itself to the execution after every change, so a restart
 * rebuilds the conversation from the execution rather than from memory. And it
 * treats a model answer as a proposal: a turn that does not validate, that asks
 * for an illegal move or that tries to produce visual output is spent, retried
 * once, and then replaced by a summary built from what the captain actually
 * said — the captain never loses a turn they already paid for.
 */
export class BriefingConversation {
  private data = emptyState();
  /**
   * One conversation runs one turn at a time, and a turn is all-or-nothing. The
   * queue is what makes a retry safe — the retry waits for the turn it is
   * retrying and then reads its recorded key — and it is what keeps a cancel
   * sent during a 60-second model call from being overwritten when that call
   * lands.
   */
  private queue: Promise<unknown> = Promise.resolve();
  /** How many turns this conversation has written to the execution; a written turn is never rolled back. */
  private commits = 0;
  private readonly timeoutMs: number;
  private readonly maxQuestions: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: BriefingConversationOptions) {
    this.timeoutMs = options.timeoutMs ?? BRIEFING_CONVERSATION_TURN_TIMEOUT_MS;
    this.maxQuestions = options.maxQuestions ?? BRIEFING_CONVERSATION_MAX_QUESTIONS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** Rebuilds the conversation from the row the execution persisted. Unreadable state is not a reason to lose the execution. */
  restore(serialized: string | null | undefined): void {
    if (!serialized) return;
    let parsed: unknown;
    try { parsed = JSON.parse(serialized) as unknown; } catch { return; }
    const snapshot = briefingConversationSnapshotSchema.safeParse(parsed);
    if (!snapshot.success) return;
    const record = snapshot.data;
    this.data = {
      state: record.state,
      originalText: record.originalText,
      normalizedText: record.normalizedText,
      messages: record.messages,
      ...(record.summary === undefined ? {} : { summary: record.summary }),
      openGaps: record.openGaps,
      askedQuestions: record.askedQuestions,
      questionCount: record.questionCount,
      attempt: record.attempt,
      ...(record.error === undefined ? {} : { error: record.error }),
      fallback: record.fallback,
      confirmations: record.confirmations,
      directions: record.directions,
      ...(record.briefing === undefined ? {} : { briefing: record.briefing }),
      appliedKeys: record.appliedKeys,
    };
  }

  get state(): BriefingConversationState { return this.data.state; }
  /** The briefing the captain confirmed, if any; the execution runs the identity stage on this. */
  get confirmedBriefing(): string | undefined { return this.data.briefing; }

  snapshot(): BriefingConversationSnapshot {
    return {
      runId: this.options.runId,
      state: this.data.state,
      originalText: this.data.originalText,
      normalizedText: this.data.normalizedText,
      messages: structuredClone(this.data.messages),
      ...(this.data.summary === undefined ? {} : { summary: this.data.summary }),
      openGaps: structuredClone(this.data.openGaps),
      askedQuestions: structuredClone(this.data.askedQuestions),
      questionCount: this.data.questionCount,
      attempt: this.data.attempt,
      ...(this.data.error === undefined ? {} : { error: { ...this.data.error } }),
      fallback: this.data.fallback,
      limitReached: this.data.questionCount >= this.maxQuestions,
      confirmations: structuredClone(this.data.confirmations),
      directions: structuredClone(this.data.directions),
      ...(this.data.briefing === undefined ? {} : { briefing: this.data.briefing }),
      appliedKeys: [...this.data.appliedKeys],
    };
  }

  serialize(): string { return JSON.stringify(this.snapshot()); }

  // ------------------------------------------------------------ one turn

  /**
   * One captain message and the model turn it pays for.
   *
   * The idempotency key is what makes a retry after a timeout safe: the same
   * key never spends a second turn, whether the first one is still running
   * (the caller joins it) or already finished (the caller reads its result).
   */
  async send(input: { message?: string | undefined; action: BriefingMessageAction; idempotencyKey: string }): Promise<BriefingConversationSnapshot> {
    if (this.data.appliedKeys.includes(input.idempotencyKey)) return this.snapshot();
    return await this.enqueue(() => this.runSend(input));
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const atomic = async (): Promise<T> => {
      const before = structuredClone(this.data);
      const written = this.commits;
      try { return await run(); }
      catch (error) {
        if (this.commits === written) this.data = before;
        throw error;
      }
    };
    const next = this.queue.then(atomic, atomic);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async runSend(input: { message?: string | undefined; action: BriefingMessageAction; idempotencyKey: string }): Promise<BriefingConversationSnapshot> {
    if (this.data.appliedKeys.includes(input.idempotencyKey)) return this.snapshot();
    if (!canSendBriefingMessage(this.data.state)) throw new ConversationError(this.closedReason(), 409);

    if (input.action === 'cancel') {
      this.append({ author: 'system', text: 'Conversa cancelada pelo capitão. A execução e o briefing já confirmado continuam disponíveis.', state: 'cancelled' });
      this.data.state = 'cancelled';
      this.data.attempt = 0;
      return await this.commit(input.idempotencyKey);
    }

    const action: 'answer' | 'correct' | 'skip' = input.action;
    const text = this.captainText(input.message, action);
    if (this.data.state === 'entry') {
      this.data.originalText = input.message ?? this.options.initialText?.() ?? '';
      this.data.normalizedText = text;
    }
    this.append({ author: 'captain', text, state: this.data.state });
    this.recordAnswer(text, action);

    const context = this.contextFor(text, action, false);
    const turn = await this.modelTurn(context);
    if (turn.ok) this.apply(turn.turn, false);
    else this.applyFallback(turn.failure);
    return await this.commit(input.idempotencyKey);
  }

  /**
   * The captain closes the briefing. The confirmed text is appended as a new
   * revision — a confirmation already recorded is never rewritten — and only
   * then is a turn spent on the three conceptual directions. The order matters:
   * a model that fails here costs the directions, never the confirmation.
   */
  async confirm(input: { briefing: string; idempotencyKey: string }): Promise<BriefingConversationSnapshot> {
    if (this.data.appliedKeys.includes(input.idempotencyKey)) return this.snapshot();
    return await this.enqueue(() => this.runConfirm(input));
  }

  private async runConfirm(input: { briefing: string; idempotencyKey: string }): Promise<BriefingConversationSnapshot> {
    if (this.data.appliedKeys.includes(input.idempotencyKey)) return this.snapshot();
    if (!canConfirmBriefing(this.data.state)) throw new ConversationError(this.confirmRefusal(), 409);
    let briefing: string;
    try { briefing = normalizeIdentityBriefing(input.briefing); }
    catch (error) { throw error instanceof BriefingValidationError ? new ConversationError(error.message, 400) : error; }

    const revision = this.data.confirmations.length + 1;
    this.data.confirmations.push({ revision, briefing, openGaps: structuredClone(this.data.openGaps), confirmedAt: this.now().toISOString(), messageCount: this.data.messages.length });
    this.data.briefing = briefing;
    this.data.summary = briefing;
    this.append({ author: 'captain', text: briefing, state: this.data.state });

    const context = this.contextFor(briefing, 'answer', true);
    const turn = await this.modelTurn(context);
    if (turn.ok) this.apply(turn.turn, true);
    else {
      // The briefing is closed either way: the directions are a reading of it,
      // not the thing the captain signed.
      this.data.state = 'final';
      this.data.directions = [];
      this.data.error = { code: turn.failure.code, message: `${turn.failure.message} O briefing foi confirmado mesmo assim; as três direções conceituais podem ser pedidas de novo.` };
      this.append({ author: 'system', text: this.data.error.message, state: 'final', fallback: true });
    }
    const snapshot = await this.commit(input.idempotencyKey);
    await this.options.onConfirmed?.(briefing, revision);
    return snapshot;
  }

  // ------------------------------------------------------- the model turn

  private async modelTurn(context: BriefingTurnContext): Promise<{ ok: true; turn: BriefingConversationTurn } | { ok: false; failure: TurnFailure }> {
    let corrections: string[] = [];
    let failure: TurnFailure = { code: 'CONVERSATION_NO_ANSWER', message: 'O modelo não respondeu a este turno.' };
    for (let attempt = 1; attempt <= BRIEFING_CONVERSATION_MAX_ATTEMPTS; attempt += 1) {
      this.data.attempt = attempt;
      const outcome = await this.invoke(context, corrections, attempt);
      if (outcome.ok) return outcome;
      failure = outcome.failure;
      // Only a violated contract is worth asking again: a transport failure
      // would answer the same way, and the captain is waiting.
      if (!outcome.corrections) return { ok: false, failure };
      corrections = outcome.corrections;
    }
    return { ok: false, failure };
  }

  private async invoke(context: BriefingTurnContext, corrections: string[], attempt: number): Promise<{ ok: true; turn: BriefingConversationTurn } | { ok: false; failure: TurnFailure; corrections?: string[] }> {
    const task = this.task(context, corrections, attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let result: AgentResult;
    try { result = await this.options.provider.propose(task, controller.signal); }
    catch (error) {
      const aborted = controller.signal.aborted;
      return { ok: false, failure: { code: aborted ? 'CONVERSATION_TIMEOUT' : 'CONVERSATION_PROVIDER_FAILED', message: aborted ? `O modelo não respondeu em ${Math.round(this.timeoutMs / 1000)} segundos.` : normalizedMessage(error) } };
    }
    finally { clearTimeout(timer); }

    if (result.status === 'failed') return { ok: false, failure: { code: result.errorCode ?? 'CONVERSATION_PROVIDER_FAILED', message: result.summary || 'A chamada ao modelo falhou.' } };
    if (!result.artifact) return { ok: false, failure: { code: result.errorCode ?? 'CONVERSATION_EMPTY_ANSWER', message: 'O modelo respondeu sem o documento tipado da conversa.' }, corrections: ['A resposta não trouxe o objeto `artifact` com o turno da conversa.'] };

    const parsed = briefingConversationTurnSchema.safeParse(result.artifact);
    if (!parsed.success) {
      return { ok: false, failure: { code: 'CONVERSATION_SCHEMA_INVALID', message: 'O modelo respondeu fora do contrato da conversa.' }, corrections: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'raiz'}: ${issue.message}`) };
    }
    const turn = parsed.data;
    const visual = findTurnVisualOutput(turn, captainWords(context));
    if (visual.length > 0) {
      return { ok: false, failure: { code: 'CONVERSATION_VISUAL_OUTPUT', message: 'O modelo tentou produzir saída visual, que pertence à etapa de identidade.' }, corrections: [`Saída visual recusada (${visual.join(', ')}). ${visualOutputReason(visual)}`] };
    }
    const problems = this.illegal(turn, context);
    if (problems.length > 0) return { ok: false, failure: { code: 'CONVERSATION_ILLEGAL_TRANSITION', message: 'O modelo pediu um passo que a conversa não permite.' }, corrections: problems };
    return { ok: true, turn };
  }

  /** The rules the closed schema cannot state on its own: where the conversation is, and what it is allowed to do next. */
  private illegal(turn: BriefingConversationTurn, context: BriefingTurnContext): string[] {
    if (briefingTurnNextStates(context.state, context).includes(turn.nextState)) return [];
    if (context.closing) return ['O capitão confirmou o briefing, então este turno precisa de intent e nextState iguais a `final`.'];
    if (turn.nextState === 'final') return ['Só a confirmação do capitão fecha o briefing; este turno não pode pedir `final`.'];
    if (turn.nextState === 'question' && context.mustConclude) return [`O limite de ${this.maxQuestions} perguntas foi atingido; ofereça um resumo em vez de perguntar.`];
    return [`De \`${context.state}\` a conversa não pode ir para \`${turn.nextState}\`.`];
  }

  /**
   * The conversation reads no document, so its task carries an empty identity
   * slice: the envelope requires the key, and an empty value is the honest way
   * to say that this worker was given nothing to read. `allowedPaths` is empty
   * for the same reason — a briefing turn never writes to the document.
   */
  private task(context: BriefingTurnContext, corrections: string[], attempt: number): AgentTask {
    const brief = briefingConversationPrompt(context, corrections);
    return {
      id: `identity-briefing-conversation-${context.turnNumber}`,
      attempt,
      stage: 'identity',
      role: 'curator',
      state: 'queued',
      lane: 'claude',
      baseVersionId: this.options.runId,
      inputDigest: hashJson({ runId: this.options.runId, turnNumber: context.turnNumber, brief }),
      promptVersion: BRIEFING_CONVERSATION_PROMPT_VERSION,
      modelAlias: 'briefing-conversation',
      deadlineMs: this.timeoutMs,
      allowedPaths: [],
      brief,
      documentSlice: { '/identity': {} },
    };
  }

  // ------------------------------------------------------------- applying

  private apply(turn: BriefingConversationTurn, closing: boolean): void {
    const next = turn.nextState;
    this.append({ author: 'studio', text: turn.message, state: next, turn });
    this.data.state = next;
    delete this.data.error;
    this.data.fallback = false;
    this.data.openGaps = structuredClone(turn.unknowns);
    if (turn.summary !== undefined) this.data.summary = turn.summary;
    if (turn.question) {
      this.data.questionCount += 1;
      this.data.askedQuestions.push({ index: this.data.askedQuestions.length, question: turn.question.text, why: turn.question.why, skipped: false });
    }
    if (closing) this.data.directions = structuredClone(turn.directions ?? []);
  }

  /**
   * Safe mode. The conversation keeps everything the captain said, explains the
   * failure in pt-BR and offers a summary built deterministically from the
   * transcript, which the captain can edit and close by hand. Offering it twice
   * in a row would be pretending; the second failure ends the conversation
   * without touching the execution or any confirmed briefing.
   */
  private applyFallback(failure: TurnFailure): void {
    const repeated = this.data.fallback;
    const state: BriefingConversationState = repeated ? 'failed' : 'confirmation';
    const summary = deterministicSummary(this.data);
    const explanation = repeated
      ? `${failure.message} A conversa foi encerrada em modo seguro. O resumo abaixo continua editável e pode ser confirmado como briefing final.`
      : `${failure.message} Nada foi fechado e nada do que você escreveu se perdeu. Montei um resumo com o que já foi dito; edite o que estiver errado e confirme quando quiser.`;
    this.data.summary = summary;
    this.data.state = state;
    this.data.fallback = true;
    this.data.error = { code: failure.code, message: explanation };
    this.append({ author: 'system', text: `${explanation}\n\n${summary}`, state, fallback: true });
  }

  // -------------------------------------------------------------- helpers

  /** The message boundary: the same size the briefing has, normalized at the edges, never empty. */
  private captainText(message: string | undefined, action: BriefingMessageAction): string {
    if (action === 'skip') {
      if (this.data.state !== 'question') throw new ConversationError('Não há pergunta aberta para pular.', 409);
      return message?.trim() || 'Prefiro não responder essa pergunta agora.';
    }
    const entry = this.data.state === 'entry' ? this.options.initialText?.() : undefined;
    if (message === undefined && entry !== undefined) return entry.trim();
    if (typeof message !== 'string') throw new ConversationError('A mensagem deve ser um texto.', 400);
    const text = message.trim();
    if (text.length === 0) throw new ConversationError('A mensagem é obrigatória e não pode estar vazia.', 400);
    if (text.length > BRIEFING_MESSAGE_MAX_LENGTH) throw new ConversationError(`A mensagem não pode ter mais de ${BRIEFING_MESSAGE_MAX_LENGTH} caracteres.`, 400);
    return text;
  }

  private recordAnswer(text: string, action: BriefingMessageAction): void {
    if (this.data.state !== 'question') return;
    const open = this.data.askedQuestions.at(-1);
    if (!open || open.answer !== undefined || open.skipped) return;
    if (action === 'skip') open.skipped = true;
    else open.answer = text;
  }

  private contextFor(currentMessage: string, action: 'answer' | 'correct' | 'skip', closing: boolean): BriefingTurnContext {
    const confirmed = this.data.confirmations.at(-1)?.briefing;
    return {
      state: this.data.state,
      turnNumber: this.data.messages.length,
      originalText: this.data.originalText,
      normalizedText: this.data.normalizedText,
      currentMessage,
      action,
      history: this.data.messages.slice(-HISTORY_WINDOW).flatMap((entry) => entry.author === 'system' ? [] : [{ author: entry.author, text: entry.text }]),
      askedQuestions: structuredClone(this.data.askedQuestions),
      openGaps: structuredClone(this.data.openGaps),
      ...(confirmed === undefined ? {} : { confirmedSummary: confirmed }),
      questionCount: this.data.questionCount,
      mustConclude: this.data.questionCount >= this.maxQuestions,
      closing,
    };
  }

  private append(entry: { author: BriefingConversationMessage['author']; text: string; state: BriefingConversationState; turn?: BriefingConversationTurn; fallback?: boolean }): void {
    this.data.messages.push({
      id: this.newId(),
      index: this.data.messages.length,
      author: entry.author,
      text: entry.text,
      createdAt: this.now().toISOString(),
      state: entry.state,
      ...(entry.turn ? { turn: structuredClone(entry.turn) } : {}),
      fallback: entry.fallback ?? false,
    });
  }

  /**
   * The key is spent only once the execution has the turn: a write that throws
   * must not leave a retry reading a success the execution never recorded.
   */
  private async commit(idempotencyKey: string): Promise<BriefingConversationSnapshot> {
    const appliedKeys = [...this.data.appliedKeys, idempotencyKey].slice(-KEY_MEMORY);
    const snapshot = { ...this.snapshot(), appliedKeys };
    await this.options.persist(snapshot);
    this.data.appliedKeys = appliedKeys;
    this.commits += 1;
    return snapshot;
  }

  private closedReason(): string {
    if (this.data.state === 'cancelled') return 'Esta conversa foi cancelada. A execução continua com o briefing com que foi criada e a etapa de identidade ainda pode ser iniciada a partir dele.';
    if (this.data.state === 'failed') return 'Esta conversa foi encerrada em modo seguro. Edite o resumo e confirme o briefing para seguir.';
    return 'O briefing desta execução já foi confirmado; confirme uma nova revisão para mudá-lo.';
  }

  private confirmRefusal(): string {
    if (this.data.state === 'cancelled') return 'Esta conversa foi cancelada e não pode fechar um briefing.';
    return 'Ainda não há um resumo para confirmar; responda a conversa até o Studio oferecer um.';
  }
}

const DECLARED_GAPS_HEADING = 'Lacunas declaradas em aberto:';

/**
 * The summary safe mode offers: only what the captain actually said, in the
 * order they said it. No model wrote any of this, which is the point.
 */
export function deterministicSummary(data: { normalizedText: string; askedQuestions: readonly BriefingAnsweredQuestion[]; openGaps: readonly BriefingGap[]; messages: readonly BriefingConversationMessage[] }): string {
  const answers = data.askedQuestions.filter((entry) => entry.answer !== undefined || entry.skipped);
  const extra = data.messages.filter((entry) => entry.author === 'captain').slice(1).map((entry) => entry.text);
  return withinBriefingLimit([
    'Resumo montado pelo Studio a partir do que você escreveu, sem interpretação do modelo.',
    '',
    'Texto inicial:',
    data.normalizedText || '(sem texto inicial)',
    ...(answers.length > 0 ? ['', 'Respostas registradas:', ...answers.map((entry) => `- ${entry.question} → ${entry.skipped ? 'pulada' : entry.answer ?? ''}`)] : []),
    ...(extra.length > 0 ? ['', 'Outras mensagens suas:', ...extra.map((text) => `- ${text}`)] : []),
    ...(data.openGaps.length > 0 ? ['', DECLARED_GAPS_HEADING, ...data.openGaps.map((gap) => `- ${gap.gap} (impacto: ${gap.impact})`)] : []),
  ].join('\n'));
}

const TRUNCATED = '\n[resumo cortado no limite do briefing; edite o que faltar antes de confirmar]';

/**
 * Safe mode offers a summary the captain is meant to confirm, so it has to fit
 * the briefing the confirmation will validate. The entry text comes first, so
 * what a cut loses is the transcript the captain can still read above it.
 */
function withinBriefingLimit(summary: string): string {
  if (summary.length <= BRIEFING_SUMMARY_MAX_LENGTH) return summary;
  return `${summary.slice(0, BRIEFING_SUMMARY_MAX_LENGTH - TRUNCATED.length).trimEnd()}${TRUNCATED}`;
}

/**
 * Everything the captain has written in this conversation, which is what
 * decides whether a value the model gave back is theirs or its own invention.
 */
function captainWords(context: BriefingTurnContext): string {
  return [
    context.originalText,
    context.normalizedText,
    context.currentMessage,
    context.confirmedSummary ?? '',
    ...context.history.flatMap((entry) => entry.author === 'captain' ? [entry.text] : []),
    ...context.askedQuestions.flatMap((entry) => entry.answer === undefined ? [] : [entry.answer]),
  ].join('\n');
}

function normalizedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() ? `A chamada ao modelo falhou: ${message.trim()}` : 'A chamada ao modelo falhou.';
}
