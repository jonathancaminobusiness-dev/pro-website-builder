import { IDENTITY_BRIEFING, IDENTITY_BRIEFING_MAX_LENGTH } from '@pwb/domain/briefing';
import { renderBriefingCreateButton, renderBriefingEditor, renderBriefingReplacementConfirmation, renderBriefingReplacementOffer, type BriefingEditorElementFactory } from '@pwb/renderer/briefing-editor';
import { createElement, useCallback, useEffect, useState, type ReactElement } from 'react';
import BriefingConversation from '../briefing/BriefingConversation.js';
import type { BriefingConversationController } from '../briefing/useBriefingConversation.js';

export interface IdentityDirectionView {
  directionId: string;
  label: string;
  versionId: string;
  parentVersionId: string;
  identityHash: string;
  thesis: string;
  tension: string;
  rationale: string;
  exclusions: string[];
  forbiddenDefaults: { fonts: string[]; palettes: string[]; motifs: string[] };
  axes: Array<{ axis: string; key: string; descriptor: string }>;
  swatches: Array<{ path: string; value: string }>;
  decisions: Array<{ choice: string; axis?: string; evidenceIds: string[]; rationale?: string }>;
  lintErrors: Array<{ id: string; path: string; message: string }>;
  blocking: Array<{ id: string; observation: string; why: string }>;
  scores: Array<{ criticId: string; dimension: string; score: number }>;
  rubricGaps: Array<{ dimension: string; score: number; evidence: string }>;
  unscoredDimensions: string[];
  blockedPairs: string[];
  abstained: boolean;
  refinedFromVersionId?: string;
  imagePlans: Array<{ id: string; role: string; axis: string; alt: string; licenceExpectation: string }>;
  imageryViolations: string[];
}

export interface IdentityGateSnapshot {
  runId: string;
  status: 'queued' | 'running' | 'needs_review' | 'approved' | 'cancelled' | 'reopened' | 'interrupted' | 'failed';
  baseVersionId: string;
  briefing: string;
  brief?: { audience: string; promise: string; proof: string[]; exclusions: string[]; evidence: Array<{ id: string; quote: string; source: string }>; unknowns: string[]; assumptions: Array<{ id: string; statement: string; risk: string }> };
  directions: IdentityDirectionView[];
  divergence?: { passed: boolean; blockedPairs: string[]; pairs: Array<{ a: string; b: string; distinctAxes: string[]; hueOnlyColor: boolean }> };
  setCritique: { scores: Array<{ criticId: string; dimension: string; score: number }>; rubricGaps: Array<{ dimension: string; score: number; evidence: string }>; unscoredDimensions: string[]; blocking: Array<{ id: string; observation: string; why: string }>; abstained: boolean };
  gate: { state: 'open'; reason: string } | { state: 'closed'; record: GateRecord } | { state: 'reopened'; record: GateRecord; impact: { changedTokenPaths: string[]; changedContractFields: string[]; staleRenderKeys: string[] } };
  approvals: Array<{ stage: string; decision: string; versionId: string; rationale: string }>;
  assets: Array<{ id: string; alt: string; status: string; provenance: { license: string; prompt?: string; termsNote?: string } }>;
  previewVersionId?: string;
  failures: Array<{ taskId: string; reason: string }>;
  error?: string;
}

interface GateRecord { directionId: string; versionId: string; identityHash: string; rationale: string; overrideRationale?: string; approvedAt: string; }

const axisLabels: Record<string, string> = {
  composition: 'Composição', typography: 'Tipografia', materiality: 'Materialidade',
  color: 'Cor', imagery: 'Imagem', motion: 'Movimento',
};

const briefingElementFactory: BriefingEditorElementFactory<ReactElement> = {
  createElement: (type, props, ...children) => createElement(type, props, ...children),
};

export interface IdentityGateProps {
  snapshot: IdentityGateSnapshot | null;
  busy: boolean;
  error: string;
  onCreate: (briefing?: string) => void;
  onOpen: (runId: string) => void;
  /** A remembered run the last read could not reach; the screen holds it rather than offering a fresh start. */
  unreachableRunId: string;
  onRetry: () => void;
  onStart: () => void;
  /** A start request or the stage/raster lane is in flight; pending starts keep cancellation available until the next server snapshot. */
  inFlight: boolean;
  startRecoveryPending: boolean;
  onCancel: () => void;
  onApprove: (directionId: string, rationale: string, overrideRationale?: string) => void;
  onReject: (directionId: string, rationale: string) => void;
  onChangeToken: (tokenPath: string, value: string) => void;
  previewOrigin: string;
  /**
   * The briefing conversation for this execution. It is optional so a Studio
   * built against a server without the conversation endpoints keeps the old
   * free-text flow exactly as it was.
   */
  conversation?: BriefingConversationController;
}

export default function IdentityGate(props: IdentityGateProps): ReactElement {
  const { snapshot } = props;
  const [rationale, setRationale] = useState('');
  const [override, setOverride] = useState('');
  const [openRunId, setOpenRunId] = useState('');
  const [confirming, setConfirming] = useState('');
  const [tokenPath, setTokenPath] = useState('color.accent');
  const [tokenValue, setTokenValue] = useState('#ff7a00');
  const [briefing, setBriefing] = useState(IDENTITY_BRIEFING);

  useEffect(() => {
    if (snapshot) setBriefing(snapshot.briefing);
  }, [snapshot?.runId, snapshot?.briefing]);

  // A closed briefing is the text a new execution would carry, so the field the
  // replacement offer reads is the summary the captain confirmed, not the text
  // that started the conversation.
  const closedBriefing = props.conversation?.closedBriefing ?? null;
  // Closing the briefing is what enables the identity stage. Only a server that
  // answered "no conversation for this run" says otherwise, so the old flow
  // starts the stage exactly as it did before; a conversation still being read
  // counts as open rather than as absent.
  const conversationAvailability = props.conversation?.state.availability;
  const briefingOpen = conversationAvailability !== undefined && conversationAvailability !== 'absent' && closedBriefing === null;
  const briefingLabel = conversationAvailability === 'unknown'
    ? 'Abrindo a conversa desta execução…'
    : conversationAvailability === 'unreachable'
      ? 'Não foi possível abrir a conversa desta execução'
      : 'Feche o briefing para executar';
  useEffect(() => {
    if (closedBriefing) setBriefing(closedBriefing);
  }, [closedBriefing]);

  const openRunForm = (label: string): ReactElement => <form className="token-form open-run" onSubmit={(event) => { event.preventDefault(); props.onOpen(openRunId.trim()); }}>
    <label htmlFor="gate1-open-run">{label}</label>
    <input id="gate1-open-run" value={openRunId} placeholder="identity-…" onChange={(event) => setOpenRunId(event.target.value)} />
    <button className="secondary" type="submit" disabled={props.busy || openRunId.trim() === ''}>Abrir</button>
  </form>;

  /**
   * The question the captain is being asked, if any: which run a new one would
   * replace, and where it was asked. A yes that cannot be given where it was
   * asked for — because the run started working, or because the screen now
   * offers a different run — is dropped rather than carried somewhere else.
   */
  const snapshotRunning = snapshot?.status === 'running';
  const assetInFlight = snapshot?.assets.some((asset) => asset.status === 'generating') === true;
  const executionInFlight = snapshotRunning || assetInFlight || props.inFlight;
  const actionsBlocked = props.inFlight || props.startRecoveryPending;
  const asking = snapshot ? `run:${snapshot.runId}` : `recovery:${props.unreachableRunId}`;
  if (confirming !== '' && (actionsBlocked || confirming !== asking)) setConfirming('');

  /**
   * Creating a run costs the one pointer this browser keeps, so it is never a
   * single click while another run is reachable: the id about to be replaced is
   * named and the captain says yes twice. While the run on screen is working
   * there is no second yes to give — the stop is the only way out of it. The
   * server snapshot is the source of truth for that working state.
   */
  const createConfirm = (replacing: string, offer: string): ReactElement => confirming === asking && !actionsBlocked
    ? renderBriefingReplacementConfirmation(briefingElementFactory, {
        replacing,
        disabled: props.busy,
        onKeep: () => setConfirming(''),
        onCreate: () => { setConfirming(''); props.onCreate(briefing.trim()); },
      })
    : renderBriefingReplacementOffer(briefingElementFactory, { label: offer, disabled: props.busy || actionsBlocked, onOpen: () => setConfirming(asking) });

  const briefingEditor = renderBriefingEditor(briefingElementFactory, { value: briefing, maxLength: IDENTITY_BRIEFING_MAX_LENGTH, onChange: setBriefing });
  const briefingCreateButton = renderBriefingCreateButton(briefingElementFactory, { disabled: props.busy || briefing.trim() === '', onCreate: () => props.onCreate(briefing.trim()) });

  const blockersOf = useCallback((direction: IdentityDirectionView): string[] => [
    ...direction.lintErrors.map((finding) => `${finding.id} · ${finding.message}`),
    ...direction.blocking.map((finding) => `${finding.id} · ${finding.observation}`),
    ...direction.rubricGaps.map((gap) => `Rubrica ${gap.dimension} · nota ${gap.score} abaixo do mínimo absoluto · ${gap.evidence}`),
    ...direction.unscoredDimensions.map((dimension) => `Rubrica ${dimension} · nenhum crítico pontuou esta direção`),
    ...direction.blockedPairs.map((pair) => `DIV-030 · ${pair}`),
    ...direction.imageryViolations,
  ], []);

  // A decided gate is closed or reopened. A token change reopens it and only a
  // re-approval of the same direction closes it again, so that one card keeps
  // its approve button while returning a card is off everywhere: the decision
  // those controls would answer is already made.
  const stopped = snapshot?.status === 'cancelled';
  const running = snapshotRunning;
  const failed = snapshot?.status === 'failed';
  const closed = snapshot?.gate.state === 'closed';
  const reopened = snapshot?.gate.state === 'reopened';
  const decided = closed || reopened;
  const record = decided ? (snapshot.gate as { record: GateRecord }).record : undefined;
  // Only a decision the server recorded marks a card: an approval it refused
  // leaves the captain's choice unmade.
  const chosen = record?.directionId;

  return <section className="gate-panel" aria-labelledby="gate1-title">
    <div className="section-heading">
      <div>
        <p className="eyebrow">Gate 1 · identidade</p>
        <h2 id="gate1-title">Três direções do mesmo briefing</h2>
        {snapshot && <p className="run-id">Execução <code>{snapshot.runId}</code></p>}
      </div>
      <span className={`status status-${snapshot?.status ?? 'queued'}`}>{statusLabel(snapshot?.status)}</span>
    </div>

    {!snapshot && !props.unreachableRunId && <div className="empty-state">
      <span>◎</span>
      <p>Nenhuma execução de identidade aberta. Criar a execução não gasta nenhuma chamada de modelo.</p>
      {briefingEditor}
      {briefingCreateButton}
      {openRunForm('Abrir execução existente')}
    </div>}

    {!snapshot && props.unreachableRunId && <div className="empty-state" role="status">
      <span>◎</span>
      <p>A execução <code>{props.unreachableRunId}</code> não pôde ser lida agora. Ela continua registrada no servidor; a decisão e as versões dela não se perderam.</p>
      <button className="primary" onClick={props.onRetry} disabled={props.busy}>{props.busy ? 'Lendo…' : 'Tentar novamente'}</button>
      {openRunForm('Abrir outra execução')}
    </div>}

    {snapshot && <>
      <p className="gate-briefing">{snapshot.briefing}</p>
      {props.conversation && <BriefingConversation
        state={props.conversation.state}
        onDraftChange={props.conversation.setDraft}
        onSummaryChange={props.conversation.setSummary}
        onSendEntry={props.conversation.sendEntry}
        onAnswer={props.conversation.answer}
        onSkip={props.conversation.skip}
        onCancel={props.conversation.cancel}
        onConfirm={props.conversation.confirm}
        onRetry={props.conversation.retry}
        onDiscard={props.conversation.discard}
        onResume={props.conversation.resume}
        onCorrect={props.conversation.correct}
      />}
      <div className="actions gate-actions">
        {!actionsBlocked && openRunForm('Abrir outra execução')}
        {createConfirm(snapshot.runId, 'Nova execução')}
        {executionInFlight && <button className="secondary" onClick={props.onCancel}>Cancelar execução</button>}
        <button className="primary" onClick={props.onStart} disabled={props.busy || props.inFlight || props.startRecoveryPending || running || stopped || briefingOpen || snapshot.directions.length > 0}>
          {stopped ? 'Execução cancelada' : snapshot.directions.length > 0 ? 'Etapa executada' : running ? 'Etapa em execução' : props.startRecoveryPending ? 'Verificando execução…' : briefingOpen ? briefingLabel : failed ? 'Tentar novamente' : props.inFlight ? 'Iniciando…' : props.busy ? 'Executando…' : 'Executar etapa de identidade'}
        </button>
      </div>

      {snapshot.divergence && <p className={snapshot.divergence.passed ? 'gate-check ok' : 'gate-check blocked'} role="status">
        {snapshot.divergence.passed
          ? `DIV-030 aprovado: cada par de direções difere em ${Math.min(...snapshot.divergence.pairs.map((pair) => pair.distinctAxes.length))} eixos ou mais.`
          : `DIV-030 bloqueia a seleção automática: ${snapshot.divergence.blockedPairs.join(' ')}`}
      </p>}

      {(snapshot.setCritique.scores.length > 0 || snapshot.setCritique.blocking.length > 0 || snapshot.setCritique.unscoredDimensions.length > 0 || snapshot.setCritique.abstained) && <div className="set-critique">
        <p className="eyebrow">Rubrica do conjunto — vale para as três direções</p>
        {snapshot.setCritique.scores.length > 0 && <ul className="score-row" aria-label="Notas dos críticos sobre o conjunto">
          {snapshot.setCritique.scores.map((score) => <li key={`${score.criticId}-${score.dimension}`} className={snapshot.setCritique.rubricGaps.some((gap) => gap.dimension === score.dimension && gap.score === score.score) ? 'below-rubric' : ''}>
            <code>{score.dimension}</code> {score.score}/4 <small>{score.criticId}</small>
          </li>)}
        </ul>}
        {(snapshot.setCritique.rubricGaps.length > 0 || snapshot.setCritique.unscoredDimensions.length > 0 || snapshot.setCritique.blocking.length > 0) && <ul className="blocker-list" aria-label="Bloqueios do conjunto">
          {snapshot.setCritique.rubricGaps.map((gap) => <li key={gap.dimension}>Rubrica {gap.dimension} · nota {gap.score} abaixo do mínimo absoluto para o conjunto · {gap.evidence}</li>)}
          {snapshot.setCritique.unscoredDimensions.map((dimension) => <li key={dimension}>Rubrica {dimension} · nenhum crítico pontuou o conjunto</li>)}
          {snapshot.setCritique.blocking.map((finding) => <li key={finding.id}>{finding.id} · {finding.observation}</li>)}
        </ul>}
        {snapshot.setCritique.abstained && <p className="gate-check blocked">Um crítico do conjunto respondeu “incerto”: a decisão sobe para o capitão.</p>}
      </div>}

      {snapshot.brief && <details className="gate-brief">
        <summary>Briefing estruturado e evidências ({snapshot.brief.evidence.length})</summary>
        <ul>{snapshot.brief.evidence.map((item) => <li key={item.id}><code>{item.id}</code> — “{item.quote}” <small>{item.source}</small></li>)}</ul>
        {snapshot.brief.unknowns.length > 0 && <p className="gate-unknowns">Não informado no briefing: {snapshot.brief.unknowns.join('; ')}.</p>}
      </details>}

      <div className="direction-grid">
        {snapshot.directions.map((direction) => {
          const blockers = blockersOf(direction);
          const isChosen = chosen === direction.directionId;
          return <article key={direction.directionId} className={`direction-card ${isChosen ? 'selected' : ''}`} aria-labelledby={`dir-${direction.directionId}`}>
            <header>
              <p className="eyebrow">{direction.directionId}</p>
              <h3 id={`dir-${direction.directionId}`}>{direction.label}</h3>
              <p className="direction-thesis">{direction.thesis}</p>
            </header>

            <ul className="swatch-row" aria-label={`Paleta de ${direction.label}`}>
              {direction.swatches.map((swatch) => <li key={swatch.path}>
                <span className="swatch" style={{ background: swatch.value }} />
                <code>{swatch.path}</code>
              </li>)}
            </ul>

            <dl className="axis-list">
              {direction.axes.map((axis) => <div key={axis.axis}>
                <dt>{axisLabels[axis.axis] ?? axis.axis}</dt>
                <dd><strong>{axis.key}</strong><span>{axis.descriptor}</span></dd>
              </div>)}
            </dl>

            <p className="direction-rationale"><strong>Rationale.</strong> {direction.rationale}</p>
            <p className="direction-tension"><strong>Tensão.</strong> {direction.tension}</p>

            <details>
              <summary>Exclusões e defaults proibidos</summary>
              <ul>
                {direction.exclusions.map((item) => <li key={item}>{item}</li>)}
                {[...direction.forbiddenDefaults.fonts, ...direction.forbiddenDefaults.palettes, ...direction.forbiddenDefaults.motifs].map((item) => <li key={item}>{item}</li>)}
              </ul>
            </details>

            <details>
              <summary>Decisões com evidência ({direction.decisions.length})</summary>
              <ul className="decision-list">
                {direction.decisions.map((decision) => <li key={decision.choice}>
                  <code>{decision.choice}</code>
                  {decision.axis && <em> · {axisLabels[decision.axis] ?? decision.axis}</em>}
                  {decision.evidenceIds.length > 0 && <em> · {decision.evidenceIds.join(', ')}</em>}
                  {decision.rationale && <span>{decision.rationale}</span>}
                </li>)}
              </ul>
            </details>

            {direction.imagePlans.length > 0 && <details>
              <summary>Planos de imagem ({direction.imagePlans.length}) — geração só após aprovação</summary>
              <ul>{direction.imagePlans.map((plan) => <li key={plan.id}><code>{plan.id}</code> · {plan.role} · {plan.alt} <small>{plan.licenceExpectation}</small></li>)}</ul>
            </details>}

            {direction.scores.length > 0 && <ul className="score-row" aria-label={`Notas dos críticos para ${direction.label}`}>
              {direction.scores.map((score) => <li key={`${score.criticId}-${score.dimension}`} className={direction.rubricGaps.some((gap) => gap.dimension === score.dimension && gap.score === score.score) ? 'below-rubric' : ''}>
                <code>{score.dimension}</code> {score.score}/4 <small>{score.criticId}</small>
              </li>)}
            </ul>}

            <p className="version-line"><code>{direction.versionId}</code> ramo de <code>{direction.parentVersionId}</code>{direction.refinedFromVersionId ? ' · refinado uma vez' : ''}</p>

            {blockers.length > 0
              ? <ul className="blocker-list" aria-label={`Bloqueios de ${direction.label}`}>{blockers.map((item) => <li key={item}>{item}</li>)}</ul>
              : <p className="gate-check ok">Sem veto determinístico nem achado bloqueante.</p>}
            {direction.abstained && <p className="gate-check blocked">Um crítico respondeu “incerto”: a decisão sobe para o capitão.</p>}
            {stopped && <p className="gate-check blocked">A execução foi parada antes do gate. Esta direção fica para leitura; nada nela pode ser decidido.</p>}

            <div className="actions">
              <button className="secondary" onClick={() => props.onReject(direction.directionId, rationale || 'Direção devolvida para revisão.')} disabled={props.busy || decided || stopped}>Devolver</button>
              <button className="primary" onClick={() => props.onApprove(direction.directionId, rationale || `Gate 1: ${direction.label}.`, override || undefined)} disabled={props.busy || closed || stopped || (reopened && !isChosen)}>
                Aprovar esta direção
              </button>
            </div>
          </article>;
        })}
      </div>

      {snapshot.directions.length > 0 && !closed && !stopped && <div className="gate-decision">
        <label htmlFor="gate-rationale">Motivo da decisão (fica registrado com o aprovador <strong>captain</strong>)</label>
        <textarea id="gate-rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} rows={2} placeholder="Por que esta direção responde ao briefing." />
        <label htmlFor="gate-override">Justificativa de override, obrigatória quando um check bloqueia a seleção automática</label>
        <textarea id="gate-override" value={override} onChange={(event) => setOverride(event.target.value)} rows={2} placeholder="Só preencher se houver bloqueio e a decisão for seguir mesmo assim." />
      </div>}

      {record && <div className="gate-record" role="status">
        <p><strong>Decisão registrada.</strong> {record.directionId} · versão <code>{record.versionId}</code> · hash da identidade <code>{record.identityHash.slice(0, 16)}…</code></p>
        <p>{record.rationale}</p>
        {record.overrideRationale && <p className="gate-override"><strong>Override registrado:</strong> {record.overrideRationale}</p>}
        {snapshot.assets.some((asset) => asset.status === 'generating') && <p className="gate-check" role="status">Gerando as imagens da direção aprovada na raia raster, uma de cada vez. A decisão já está registrada.</p>}
        {snapshot.assets.length > 0 && <ul className="asset-list">{snapshot.assets.map((asset) => <li key={asset.id}>
          <code>{asset.id}</code> · {asset.status === 'generating' ? 'gerando…' : asset.status} · licença: {asset.provenance.license}
        </li>)}</ul>}
      </div>}

      {record && <div className="gate-token-change">
        <p className="eyebrow">Mudança de token depois do gate</p>
        <div className="token-form">
          <label htmlFor="token-path">Token</label>
          <input id="token-path" value={tokenPath} onChange={(event) => setTokenPath(event.target.value)} />
          <label htmlFor="token-value">Novo valor</label>
          <input id="token-value" value={tokenValue} onChange={(event) => setTokenValue(event.target.value)} />
          <button className="secondary" onClick={() => props.onChangeToken(tokenPath, tokenValue)} disabled={props.busy}>Aplicar mudança de token</button>
        </div>
      </div>}

      {snapshot.gate.state === 'reopened' && <p className="gate-check blocked" role="alert">
        Gate 1 reaberto: {snapshot.gate.impact.changedTokenPaths.join(', ')} mudou depois da aprovação e {snapshot.gate.impact.staleRenderKeys.length} renders dependentes foram invalidados.
      </p>}

      {snapshot.previewVersionId && <iframe title="Preview da identidade aprovada" className="preview-frame" sandbox="" src={`${props.previewOrigin}/preview/${encodeURIComponent(snapshot.previewVersionId)}/`} />}

      {snapshot.failures.length > 0 && <ul className="blocker-list" aria-label="Falhas da execução">{snapshot.failures.map((failure, position) => <li key={`${failure.taskId}#${position}`}>{failure.taskId}: {failure.reason}</li>)}</ul>}
      {snapshot.error && <p className="error-banner" role="alert">{snapshot.error}</p>}
    </>}

    {props.error && <p className="error-banner" role="alert">{props.error}</p>}
  </section>;
}

function statusLabel(status: IdentityGateSnapshot['status'] | undefined): string {
  switch (status) {
    case 'queued': return 'pronto para executar';
    case 'running': return 'executando';
    case 'needs_review': return 'aguarda gate';
    case 'approved': return 'aprovado';
    case 'cancelled': return 'cancelada';
    case 'reopened': return 'reaberto';
    case 'interrupted': return 'interrompido pelo reinício';
    case 'failed': return 'falhou';
    default: return 'sem execução';
  }
}
