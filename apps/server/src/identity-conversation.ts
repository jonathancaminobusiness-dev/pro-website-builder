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
  canReopenBriefingConversation,
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
  type BriefingConversationRevision,
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

/** The round a damaged record still names, when it names one this server can trust. */
function revisionOf(parsed: unknown): number | undefined {
  const value = parsed !== null && typeof parsed === 'object' ? (parsed as { revision?: unknown }).revision : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The first field the persisted conversation got wrong, worded for the captain rather than for a schema. */
function parseProblem(issues: ReadonlyArray<{ path: Array<string | number>; message: string }>): string {
  const first = issues[0];
  if (!first) return 'o texto salvo não corresponde ao contrato da conversa';
  const field = first.path.join('.');
  return field ? `o campo ${field} do registro salvo é inválido (${first.message})` : first.message;
}

/**
 * Why a damaged execution refuses, and what the captain can still do about it.
 * Gate 1 and the conversation routes answer with the same sentence, because it
 * is the same fact: nothing on this execution was signed that anyone can read.
 */
export function unreadableConversationReason(reason: string): string {
  return `A conversa de briefing desta execução não pôde ser lida (${reason}), então nenhum briefing confirmado pode ser recuperado dela. Abra outra conversa nesta execução para recomeçar: o registro danificado é arquivado como está, e nada dele se perde.`;
}

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
  /**
   * Writes the conversation onto the execution after every change that must
   * survive a restart. A confirmation passes the briefing it signed as well,
   * because the transcript and the execution's briefing must move in one
   * transaction or not at all.
   */
  persist: (snapshot: BriefingConversationSnapshot, confirmedBriefing?: string) => Promise<void>;
  /**
   * Called once the confirmation is durable, so the execution can pick the
   * briefing up in memory. It runs after the write, never before: nothing the
   * execution holds may name a briefing no persisted row does.
   */
  onConfirmed?: (briefing: string) => Promise<void> | void;
  /**
   * Asked before a turn is spent, and free to refuse it with a
   * `ConversationError`: an execution the captain stopped, or one whose
   * briefing is frozen because it already holds identity work, must not buy a
   * 60-second model call whose answer it could never take. A confirmation asks
   * twice — once before the turn and once at the moment the briefing is
   * written — because the execution can be stopped or started while the turn
   * runs, and only the second ask sees that.
   */
  guardTurn?: () => void;
  /**
   * Runs the confirmation's write and hand-off as one critical section. The
   * execution takes the same section to claim its stage, so a start can never
   * land between the freeze check and the briefing that check protects.
   */
  confirmSection?: <T>(work: () => Promise<T>) => Promise<T>;
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
  previousRevisions: BriefingConversationRevision[];
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
  return { state: 'entry', previousRevisions: [], originalText: '', normalizedText: '', messages: [], openGaps: [], askedQuestions: [], questionCount: 0, attempt: 0, fallback: false, confirmations: [], directions: [], appliedKeys: [] };
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
  /**
   * Set by `restore` when the execution's row exists but no readable
   * conversation could be built from it: why it was refused, and the bytes
   * themselves, which are the only copy of what that round said.
   */
  private damaged: { reason: string; raw: string; revision?: number } | undefined;
  private readonly timeoutMs: number;
  private readonly maxQuestions: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly confirmSection: <T>(work: () => Promise<T>) => Promise<T>;

  constructor(private readonly options: BriefingConversationOptions) {
    this.confirmSection = options.confirmSection ?? (async (work) => await work());
    this.timeoutMs = options.timeoutMs ?? BRIEFING_CONVERSATION_TURN_TIMEOUT_MS;
    this.maxQuestions = options.maxQuestions ?? BRIEFING_CONVERSATION_MAX_QUESTIONS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /**
   * Rebuilds the conversation from the row the execution persisted.
   *
   * A row that exists but cannot be read is not silently dropped. Dropping it
   * would leave the defaults of a conversation nobody had — which is exactly
   * what a legacy execution looks like — so a cancelled round would come back
   * as a briefing the stage may start on, and the first write would replace a
   * transcript still on disk. The execution is marked unreadable instead: it
   * refuses to spend a turn, refuses to confirm, and starts nothing until the
   * captain opens the next round over it.
   */
  restore(serialized: string | null | undefined): void {
    if (!serialized) return;
    let parsed: unknown;
    try { parsed = JSON.parse(serialized) as unknown; }
    catch { this.damaged = { reason: 'o texto salvo não é um JSON válido', raw: serialized }; return; }
    const snapshot = briefingConversationSnapshotSchema.safeParse(parsed);
    if (!snapshot.success) {
      const revision = revisionOf(parsed);
      this.damaged = { reason: parseProblem(snapshot.error.issues), raw: serialized, ...(revision === undefined ? {} : { revision }) };
      return;
    }
    this.damaged = undefined;
    const record = snapshot.data;
    this.data = {
      state: record.state,
      previousRevisions: record.previousRevisions,
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
  /**
   * Which round this execution is on, counted from the rounds it carries rather
   * than stored beside them. A round the server could not read is still a round
   * it archived, so the count never has to be invented — and it can never drift
   * from the history it describes.
   */
  private get revision(): number { return this.data.previousRevisions.length + 1; }
  /** Why this execution's persisted conversation could not be read, when it could not. */
  get unreadable(): string | undefined { return this.damaged?.reason; }
  /** The briefing the captain confirmed, if any; the execution runs the identity stage on this. */
  get confirmedBriefing(): string | undefined { return this.data.briefing; }

  /**
   * True once this execution has a briefing conversation at all.
   *
   * It is the line between the new flow and the legacy one, which is why it
   * reads facts a conversation writes rather than the state: an execution whose
   * captain never opened the chat sits at `entry` with nothing in it, exactly
   * as a legacy execution created straight from a briefing field does, and both
   * keep today's behaviour. Anything the captain actually did — a message, a
   * confirmed revision, a round they closed and reopened — makes the
   * conversation the thing that decides this execution's briefing.
   */
  get opened(): boolean {
    return this.data.messages.length > 0 || this.data.confirmations.length > 0 || this.data.previousRevisions.length > 0;
  }

  snapshot(): BriefingConversationSnapshot {
    return {
      runId: this.options.runId,
      state: this.data.state,
      revision: this.revision,
      previousRevisions: structuredClone(this.data.previousRevisions),
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
      ...(this.damaged === undefined ? {} : { unreadable: { reason: this.damaged.reason } }),
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
      // The damaged record rolls back with the rest: a reopen whose write fails
      // leaves the execution damaged, never downgraded to the legacy flow.
      const damagedBefore = this.damaged;
      const written = this.commits;
      try { return await run(); }
      catch (error) {
        if (this.commits === written) { this.data = before; this.damaged = damagedBefore; }
        throw error;
      }
    };
    const next = this.queue.then(atomic, atomic);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async runSend(input: { message?: string | undefined; action: BriefingMessageAction; idempotencyKey: string }): Promise<BriefingConversationSnapshot> {
    if (this.data.appliedKeys.includes(input.idempotencyKey)) return this.snapshot();
    this.refuseUnreadable();
    // The execution answers before the conversation does, so a captain on a
    // frozen execution reads the same refusal from both routes instead of being
    // sent to a revision the confirmation would refuse.
    this.options.guardTurn?.();
    if (!canSendBriefingMessage(this.data.state)) throw new ConversationError(this.closedReason(), 409);

    if (input.action === 'cancel') {
      // A conversation nobody wrote in has nothing to close, and closing it
      // anyway would strand the execution: `opened` would go true and the
      // legacy start would lose the briefing the execution was created with.
      // So the stop leaves it exactly as it found it — unopened — and the
      // captain keeps both the legacy flow and the chat.
      if (!this.opened) return await this.commit(input.idempotencyKey);
      this.append({ author: 'system', text: 'Conversa cancelada pelo capitão. Nada foi enviado ao curador e a execução continua reabrível: abra outra conversa nela quando quiser, que esta continua legível.', state: 'cancelled' });
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
    this.refuseUnreadable();
    this.options.guardTurn?.();
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
    // The write and the hand-off run inside the execution's own critical
    // section, and the guard is asked again there: the ask before the turn
    // cannot see a stop or a stage start that lands inside the up-to-60-second
    // closing turn, and this one cannot be overtaken by a start, because the
    // execution takes the same section to claim its stage. Both asks stay:
    // refusing before the turn is what keeps the captain from paying for it.
    return await this.confirmSection(async () => {
      this.options.guardTurn?.();
      const snapshot = await this.commit(input.idempotencyKey, briefing);
      await this.options.onConfirmed?.(briefing);
      return snapshot;
    });
  }

  /**
   * Opens the next conversation round on an execution whose last one was
   * cancelled or failed.
   *
   * It buys no model turn and signs nothing: the closed round is archived whole
   * and the new one starts at `entry`, so the captain types their next message
   * through the one message route. What the execution already carries is
   * untouched — the confirmations it has signed, the briefing it runs on and
   * the idempotency keys it has spent all survive, because a reopen is another
   * round of the same execution and never a new execution.
   */
  async reopen(input: { idempotencyKey: string }): Promise<BriefingConversationSnapshot> {
    if (this.data.appliedKeys.includes(input.idempotencyKey)) return this.snapshot();
    return await this.enqueue(() => this.runReopen(input));
  }

  private async runReopen(input: { idempotencyKey: string }): Promise<BriefingConversationSnapshot> {
    if (this.data.appliedKeys.includes(input.idempotencyKey)) return this.snapshot();
    // The same ask every route that writes to this execution makes: a stopped
    // execution, or one whose briefing is frozen because it already holds
    // identity work, has nothing to gain from a round it could never close.
    this.options.guardTurn?.();
    // The one route an unreadable execution still answers. What could not be
    // read is archived exactly as it was found — it is the only copy of that
    // round — and the captain says again, in a round this server wrote, what
    // the damaged record no longer shows them.
    if (this.damaged !== undefined) {
      const damaged = this.damaged;
      const archived: BriefingConversationRevision = {
        revision: this.revision,
        closedAs: 'unreadable',
        closedAt: this.now().toISOString(),
        messages: [],
        openGaps: [],
        askedQuestions: [],
        questionCount: 0,
        unreadable: { reason: damaged.reason, raw: damaged.raw, ...(damaged.revision === undefined ? {} : { claimedRevision: damaged.revision }) },
      };
      const carried = this.data.previousRevisions;
      this.data = emptyState();
      this.data.previousRevisions = [...carried, archived];
      this.damaged = undefined;
      // The damaged round takes the next position like any other, and what its
      // own record claimed to be travels with the bytes rather than deciding
      // where it sits.
      this.append({ author: 'system', text: `A conversa anterior desta execução não pôde ser lida (${damaged.reason}); o registro dela fica arquivado exatamente como estava. Esta é a conversa ${this.revision} desta execução.`, state: 'entry' });
      return await this.commit(input.idempotencyKey);
    }
    if (!canReopenBriefingConversation(this.data.state)) throw new ConversationError(this.reopenRefusal(), 409);

    const closed: BriefingConversationRevision = {
      revision: this.revision,
      closedAs: this.data.state,
      closedAt: this.now().toISOString(),
      messages: structuredClone(this.data.messages),
      ...(this.data.summary === undefined ? {} : { summary: this.data.summary }),
      openGaps: structuredClone(this.data.openGaps),
      askedQuestions: structuredClone(this.data.askedQuestions),
      questionCount: this.data.questionCount,
      ...(this.data.error === undefined ? {} : { error: { ...this.data.error } }),
    };
    this.data.previousRevisions.push(closed);
    this.data.state = 'entry';
    this.data.messages = [];
    this.data.originalText = '';
    this.data.normalizedText = '';
    this.data.askedQuestions = [];
    this.data.openGaps = [];
    this.data.directions = [];
    this.data.questionCount = 0;
    this.data.attempt = 0;
    this.data.fallback = false;
    delete this.data.summary;
    delete this.data.error;
    this.append({ author: 'system', text: `Conversa ${closed.revision} encerrada como ${closed.closedAs === 'cancelled' ? 'cancelada' : 'falha'}; ela continua legível acima. Esta é a conversa ${this.revision} desta execução.`, state: 'entry' });
    return await this.commit(input.idempotencyKey);
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

    // An answer that names another task is another turn's answer: a provider
    // resolving out of order would otherwise write its summary and its question
    // into the transcript under this turn's number.
    if (result.taskId !== task.id) {
      return { ok: false, failure: { code: 'CONVERSATION_TASK_MISMATCH', message: 'O modelo respondeu a outro turno desta execução.' }, corrections: [`A resposta trouxe \`taskId\` \`${result.taskId}\`, mas este turno é \`${task.id}\`.`] };
    }
    if (result.status === 'failed') return { ok: false, failure: { code: result.errorCode ?? 'CONVERSATION_PROVIDER_FAILED', message: result.summary || 'A chamada ao modelo falhou.' } };
    if (!result.artifact) return { ok: false, failure: { code: result.errorCode ?? 'CONVERSATION_EMPTY_ANSWER', message: 'O modelo respondeu sem o documento tipado da conversa.' }, corrections: ['A resposta não trouxe o objeto `artifact` com o turno da conversa.'] };

    const parsed = briefingConversationTurnSchema.safeParse(result.artifact);
    if (!parsed.success) {
      return { ok: false, failure: { code: 'CONVERSATION_SCHEMA_INVALID', message: 'O modelo respondeu fora do contrato da conversa.' }, corrections: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'raiz'}: ${issue.message}`) };
    }
    const turn = parsed.data;
    const visual = findTurnVisualOutput(turn, this.captainWords());
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
    // The closing turn reads a briefing the captain already signed, so its
    // summary is an echo: the signed text stands and only the directions are the
    // model's to add.
    if (!closing && turn.summary !== undefined) this.data.summary = turn.summary;
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

  /**
   * Everything the captain has written in this conversation, which is what
   * decides whether a value the model gave back is theirs or its own invention.
   * It reads the whole transcript rather than the prompt's history window: what
   * the captain wrote stays theirs however long the conversation gets, and
   * HISTORY_WINDOW is a prompt-size rule, not a rule about authorship.
   */
  private captainWords(): string {
    return [
      this.data.originalText,
      this.data.normalizedText,
      this.data.confirmations.at(-1)?.briefing ?? '',
      ...this.data.messages.flatMap((entry) => entry.author === 'captain' ? [entry.text] : []),
      ...this.data.askedQuestions.flatMap((entry) => entry.answer === undefined ? [] : [entry.answer]),
    ].join('\n');
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
   * must not leave a retry reading a success the execution never recorded. The
   * key travels inside the same write as the turn it belongs to — and, on a
   * confirmation, inside the same write as the briefing it signed.
   */
  private async commit(idempotencyKey: string, confirmedBriefing?: string): Promise<BriefingConversationSnapshot> {
    const appliedKeys = [...this.data.appliedKeys, idempotencyKey].slice(-KEY_MEMORY);
    const snapshot = { ...this.snapshot(), appliedKeys };
    await this.options.persist(snapshot, confirmedBriefing);
    this.data.appliedKeys = appliedKeys;
    this.commits += 1;
    return snapshot;
  }

  private refuseUnreadable(): void {
    if (this.damaged !== undefined) throw new ConversationError(unreadableConversationReason(this.damaged.reason), 409);
  }

  private closedReason(): string {
    if (this.data.state === 'cancelled') return 'Esta conversa foi cancelada e não fechou nenhum briefing. Abra outra conversa nesta execução para seguir; esta continua legível.';
    if (this.data.state === 'failed') return 'Esta conversa foi encerrada em modo seguro. Edite o resumo e confirme o briefing, ou abra outra conversa nesta execução.';
    return 'O briefing desta execução já foi confirmado; confirme uma nova revisão para mudá-lo.';
  }

  private reopenRefusal(): string {
    if (this.data.state === 'final') return 'O briefing desta execução já foi confirmado; confirme uma nova revisão para mudá-lo, em vez de abrir outra conversa.';
    if (this.data.messages.length === 0) return 'Esta conversa ainda está vazia, então não há nada para reabrir: escreva nela quando quiser começar.';
    return 'Esta conversa ainda está aberta; cancele-a antes de abrir outra nesta execução.';
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

function normalizedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() ? `A chamada ao modelo falhou: ${message.trim()}` : 'A chamada ao modelo falhou.';
}
