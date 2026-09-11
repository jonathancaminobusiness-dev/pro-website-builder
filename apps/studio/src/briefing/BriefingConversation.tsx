import { useEffect, useRef, type ReactElement } from 'react';
import { atMessageLimit, type ConversationTurn } from './contract.js';
import { affordances, pendingMessage, progressLabel, type ConversationUiState } from './machine.js';

/**
 * The short conversation that happens before the identity stage. It reads a
 * text, gives a first reading, asks one question at a time, and ends in a
 * summary the captain edits and closes.
 *
 * Copy boundary: nothing here says “ver proposta”, “gerar identidade” or
 * “abrir preview”, and no control in this panel opens one. The only way out is
 * “Fechar briefing”; the visual stage owns the rest.
 */
export interface BriefingConversationProps {
  state: ConversationUiState;
  /** Injected so the time ceiling is decidable in a test. */
  now?: Date;
  onDraftChange: (value: string) => void;
  onSummaryChange: (value: string) => void;
  onSendEntry: () => void;
  onAnswer: () => void;
  onSkip: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  onResume: () => void;
  /** Loads a past answer back into the field so the captain can correct it. */
  onCorrect: (turn: ConversationTurn) => void;
}

const intentLabels: Record<ConversationTurn['intent'], string> = {
  entry: 'Você · entrada',
  recommendation: 'Studio · recomendação',
  question: 'Studio · pergunta de esclarecimento',
  answer: 'Você · resposta',
  skip: 'Você · pulou a pergunta',
  confirmation: 'Studio · confirmação',
  final: 'Studio · resumo',
  cancel: 'Você · cancelou',
};

function readingList(title: string, items: string[], className: string): ReactElement | null {
  if (items.length === 0) return null;
  return <div className={`reading-group ${className}`}>
    <p className="reading-title">{title}</p>
    <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
  </div>;
}

export default function BriefingConversation(props: BriefingConversationProps): ReactElement | null {
  const { state } = props;
  const now = props.now ?? new Date();
  const can = affordances(state, now);
  const snapshot = state.snapshot;
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const questionId = snapshot?.question?.id;

  // The one question on screen takes focus when it arrives, so a captain on the
  // keyboard lands in the field that is being asked for.
  useEffect(() => { if (questionId) answerRef.current?.focus(); }, [questionId]);

  // A server with no conversation for this run says nothing about the briefing
  // flow that already exists: the panel disappears and the old field decides.
  if (state.availability === 'absent') return null;

  const progress = progressLabel(state);
  const bubble = pendingMessage(state);

  if (!snapshot) {
    return <section className="briefing-chat" aria-labelledby="briefing-chat-title">
      <div className="section-heading">
        <div><p className="eyebrow">Antes do Gate 1</p><h2 id="briefing-chat-title">Conversa de briefing</h2></div>
      </div>
      <p className="chat-progress" role="status">{progress ?? 'Abrindo a conversa desta execução…'}</p>
      {state.failure && <ChatFailure failure={state.failure} canRetry={can.canRetry} onRetry={props.onRetry} onResume={props.onResume} />}
    </section>;
  }

  const counter = `${snapshot.messageCount}/${snapshot.limits.messageLimit} mensagens`;
  // What is on screen is decided by the same affordances that decide what can be
  // sent, so no control renders that could never act.
  const showSummary = can.summaryOpen;
  const showEntry = !can.closed && !can.atLimit && snapshot.state === 'entry';
  const showQuestion = can.asking;
  // Correcting a turn loads it back into the draft, so it is offered only while
  // a field bound to the draft is on screen to receive it.
  const draftVisible = showEntry || showQuestion;

  return <section className="briefing-chat" aria-labelledby="briefing-chat-title">
    <div className="section-heading">
      <div>
        <p className="eyebrow">Antes do Gate 1</p>
        <h2 id="briefing-chat-title">Conversa de briefing</h2>
        <p className="chat-hint">Uma pergunta por vez, só onde a resposta muda a identidade. Nada aqui abre proposta visual.</p>
      </div>
      <span className={`status status-chat-${snapshot.state}`}>{stateLabel(snapshot.state, can.closed)}</span>
    </div>

    <p className="chat-counter" aria-live="polite">
      <span>{counter}</span>
      {can.atLimit && <strong> · limite atingido: revise o resumo e feche o briefing manualmente.</strong>}
    </p>

    <ol className="chat-log" role="log" aria-live="polite" aria-label="Histórico da conversa de briefing">
      {snapshot.turns.map((turn) => <li key={turn.id} className={`chat-turn chat-${turn.role}`}>
        <p className="chat-role">{intentLabels[turn.intent]}</p>
        <p className="chat-message">{turn.message}</p>
        {readingList('Fatos que você disse', turn.facts, 'facts')}
        {readingList('Hipóteses do Studio', turn.hypotheses, 'hypotheses')}
        {readingList('Ainda desconhecido', turn.unknowns, 'unknowns')}
        {turn.question && <p className="chat-why"><strong>Por que isso muda a identidade.</strong> {turn.question.why}</p>}
        {turn.role === 'captain' && draftVisible && <button className="secondary chat-correct" onClick={() => props.onCorrect(turn)} disabled={can.busy}>Corrigir esta resposta</button>}
      </li>)}
      {bubble !== null && <li className="chat-turn chat-captain chat-pending" aria-hidden={false}>
        <p className="chat-role">Você · enviando</p>
        <p className="chat-message">{bubble}</p>
      </li>}
    </ol>

    {progress && <p className="chat-progress" role="status">{progress}</p>}

    {state.failure && <ChatFailure failure={state.failure} canRetry={can.canRetry} onRetry={props.onRetry} onResume={props.onResume} />}

    {showEntry && <div className="chat-compose">
      <label htmlFor="briefing-chat-entry">Conte sobre o negócio: nicho, promessa, provas e o que a identidade deve evitar</label>
      <textarea
        id="briefing-chat-entry"
        rows={5}
        value={state.draft}
        maxLength={snapshot.limits.briefingMaxLength}
        onChange={(event) => props.onDraftChange(event.target.value)}
        placeholder="Ex.: somos uma clínica veterinária de bairro; queremos prevenção, sem parecer hospital frio nem pet shop genérico."
      />
      <div className="briefing-meta">
        <small>O texto fica salvo na execução antes da primeira leitura.</small>
        <span aria-live="polite">{state.draft.length}/{snapshot.limits.briefingMaxLength} caracteres</span>
      </div>
      <div className="actions">
        <button className="primary" onClick={props.onSendEntry} disabled={!can.canSendEntry}>Enviar para leitura</button>
      </div>
    </div>}

    {showQuestion && snapshot.question && <div className="chat-question">
      <p className="chat-question-prompt" id="briefing-chat-question">{snapshot.question.prompt}</p>
      <p className="chat-why"><strong>Por que isso muda a identidade.</strong> {snapshot.question.why}</p>
      {snapshot.question.options && snapshot.question.options.length > 0 && <ul className="chat-options" aria-label="Respostas sugeridas">
        {snapshot.question.options.map((option) => <li key={option}>
          <button className="secondary" onClick={() => props.onDraftChange(option)} disabled={can.busy}>{option}</button>
        </li>)}
      </ul>}
      <label htmlFor="briefing-chat-answer">Sua resposta</label>
      <textarea
        id="briefing-chat-answer"
        ref={answerRef}
        rows={3}
        value={state.draft}
        maxLength={snapshot.limits.briefingMaxLength}
        aria-describedby="briefing-chat-question"
        onChange={(event) => props.onDraftChange(event.target.value)}
      />
      <div className="actions">
        <button className="secondary" onClick={props.onSkip} disabled={!can.canSkip}>Pular esta pergunta</button>
        <button className="primary" onClick={props.onAnswer} disabled={!can.canAnswer}>Responder</button>
      </div>
    </div>}

    {showSummary && <div className="chat-summary">
      <p className="eyebrow">Resumo consolidado</p>
      <label htmlFor="briefing-chat-summary">Briefing final, editável. Fechar é o que libera a etapa de identidade.</label>
      <textarea
        id="briefing-chat-summary"
        rows={7}
        value={state.summaryDraft}
        maxLength={snapshot.limits.briefingMaxLength}
        onChange={(event) => props.onSummaryChange(event.target.value)}
      />
      <div className="briefing-meta">
        <small>{atMessageLimit(snapshot) ? 'A conversa chegou ao teto de mensagens; o fechamento agora é manual.' : 'Corrija o que estiver errado antes de fechar.'}</small>
        <span aria-live="polite">{state.summaryDraft.length}/{snapshot.limits.briefingMaxLength} caracteres</span>
      </div>
      <div className="actions">
        <button className="primary" onClick={props.onConfirm} disabled={!can.canConfirm}>Fechar briefing</button>
      </div>
    </div>}

    {/* The way out of the conversation, reported by the contract rather than by
        whichever control block happens to be on screen: a state that shows no
        composer — the first reading, a summary the server has not decided yet,
        a failed conversation — still has an exit. */}
    {!can.closed && <div className="actions chat-exit">
      <button className="secondary" onClick={props.onCancel} disabled={!can.canCancel}>Cancelar conversa</button>
      {state.failure === null && <button className="secondary" onClick={props.onResume} disabled={can.busy}>Reabrir do ponto salvo</button>}
    </div>}

    {snapshot.state === 'cancelled' && <p className="chat-cancelled" role="status">
      Conversa cancelada. Nada foi enviado ao curador e nenhuma etapa de identidade foi gasta. A execução continua aberta: reabra a conversa do ponto salvo ou feche o briefing pelo resumo editável acima, que é o que libera a etapa de identidade.
    </p>}

    {can.closed && <p className="chat-closed" role="status">
      Briefing fechado. A etapa de identidade já pode ser executada com este texto.
    </p>}

    {snapshot.state === 'failed' && <p className="error-banner" role="alert">
      A conversa parou: {snapshot.error ?? 'o servidor não conseguiu continuar.'} Nada foi fechado e nada foi enviado ao curador; reabra a conversa do ponto salvo ou feche o briefing pelo resumo editável.
    </p>}

    {snapshot.directions.length > 0 && <div className="chat-directions">
      <p className="eyebrow">Três direções conceituais — texto, sem preview</p>
      <div className="chat-direction-grid">
        {snapshot.directions.map((direction) => <article key={direction.id} className="chat-direction" aria-labelledby={`chat-dir-${direction.id}`}>
          <h3 id={`chat-dir-${direction.id}`}>{direction.label}</h3>
          <p className="chat-direction-thesis">{direction.thesis}</p>
          <dl>
            <div><dt>Posicionamento</dt><dd>{direction.positioning}</dd></div>
            <div><dt>Tom e linguagem</dt><dd>{direction.tone}</dd></div>
            <div><dt>Visual e composição</dt><dd>{direction.composition}</dd></div>
            <div><dt>Tipografia e aplicações</dt><dd>{direction.typography}</dd></div>
          </dl>
          <p className="chat-direction-note">conceito descrito · sem preview</p>
        </article>)}
      </div>
    </div>}
  </section>;
}

function ChatFailure(props: { failure: { kind: string; message: string }; canRetry: boolean; onRetry: () => void; onResume: () => void }): ReactElement {
  return <div className="chat-failure" role="alert">
    <p>{props.failure.message}</p>
    <div className="actions">
      <button className="secondary" onClick={props.onResume}>Reabrir do ponto salvo</button>
      {props.canRetry && <button className="primary" onClick={props.onRetry}>Tentar novamente</button>}
    </div>
  </div>;
}

function stateLabel(state: string, closed: boolean): string {
  if (closed) return 'briefing fechado';
  switch (state) {
    case 'entry': return 'aguardando seu texto';
    case 'recommendation': return 'primeira leitura';
    case 'question': return 'uma pergunta aberta';
    case 'confirmation': return 'aguardando confirmação';
    case 'final': return 'resumo pronto';
    case 'cancelled': return 'cancelada';
    case 'failed': return 'falhou';
    default: return state;
  }
}
