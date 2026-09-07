import { useCallback, useState, type ReactElement } from 'react';

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
  rubricGaps: Array<{ dimension: string; score: number }>;
  abstained: boolean;
  refinedFromVersionId?: string;
  imagePlans: Array<{ id: string; role: string; axis: string; alt: string; licenceExpectation: string }>;
  imageryViolations: string[];
}

export interface IdentityGateSnapshot {
  runId: string;
  status: 'queued' | 'running' | 'needs_review' | 'approved' | 'reopened' | 'failed';
  baseVersionId: string;
  briefing: string;
  brief?: { audience: string; promise: string; proof: string[]; exclusions: string[]; evidence: Array<{ id: string; quote: string; source: string }>; unknowns: string[]; assumptions: Array<{ id: string; statement: string; risk: string }> };
  directions: IdentityDirectionView[];
  divergence?: { passed: boolean; blockedPairs: string[]; pairs: Array<{ a: string; b: string; distinctAxes: string[]; hueOnlyColor: boolean }> };
  gate: { state: 'open'; reason: string } | { state: 'closed'; record: GateRecord } | { state: 'reopened'; record: GateRecord; impact: { changedTokenPaths: string[]; changedContractFields: string[]; staleRenderKeys: string[] } };
  approvals: Array<{ stage: string; decision: string; versionId: string; rationale: string }>;
  assets: Array<{ id: string; alt: string; status: string; provenance: { license: string; prompt?: string; termsNote?: string } }>;
  previewVersionId?: string;
  failures: Array<{ taskId: string; reason: string }>;
  error?: string;
}

interface GateRecord { directionId: string; versionId: string; identityHash: string; rationale: string; approvedAt: string; }

const axisLabels: Record<string, string> = {
  composition: 'Composição', typography: 'Tipografia', materiality: 'Materialidade',
  color: 'Cor', imagery: 'Imagem', motion: 'Movimento',
};

export interface IdentityGateProps {
  snapshot: IdentityGateSnapshot | null;
  busy: boolean;
  error: string;
  onCreate: () => void;
  onStart: () => void;
  onApprove: (directionId: string, rationale: string, overrideRationale?: string) => void;
  onReject: (directionId: string, rationale: string) => void;
  onChangeToken: (tokenPath: string, value: string) => void;
  previewOrigin: string;
}

export default function IdentityGate(props: IdentityGateProps): ReactElement {
  const { snapshot } = props;
  const [rationale, setRationale] = useState('');
  const [override, setOverride] = useState('');
  const [tokenPath, setTokenPath] = useState('color.accent');
  const [tokenValue, setTokenValue] = useState('#ff7a00');

  const blockersOf = useCallback((direction: IdentityDirectionView): string[] => [
    ...direction.lintErrors.map((finding) => `${finding.id} · ${finding.message}`),
    ...direction.blocking.map((finding) => `${finding.id} · ${finding.observation}`),
    ...direction.imageryViolations,
    ...(snapshot?.divergence?.blockedPairs ?? []),
  ], [snapshot]);

  // A closed gate is the only decided state: a token change reopens it, and the
  // captain has to be able to decide again from here.
  const closed = snapshot?.gate.state === 'closed';
  const decided = closed || snapshot?.gate.state === 'reopened';
  const record = decided ? (snapshot.gate as { record: GateRecord }).record : undefined;
  // Only a decision the server recorded marks a card: an approval it refused
  // leaves the captain's choice unmade.
  const chosen = record?.directionId;

  return <section className="gate-panel" aria-labelledby="gate1-title">
    <div className="section-heading">
      <div>
        <p className="eyebrow">Gate 1 · identidade</p>
        <h2 id="gate1-title">Três direções do mesmo briefing</h2>
      </div>
      <span className={`status status-${snapshot?.status ?? 'queued'}`}>{statusLabel(snapshot?.status)}</span>
    </div>

    {!snapshot && <div className="empty-state">
      <span>◎</span>
      <p>Nenhuma execução de identidade aberta. Criar a execução não gasta nenhuma chamada de modelo.</p>
      <button className="primary" onClick={props.onCreate} disabled={props.busy}>Criar execução de identidade</button>
    </div>}

    {snapshot && <>
      <p className="gate-briefing">{snapshot.briefing}</p>
      <div className="actions gate-actions">
        <button className="secondary" onClick={props.onCreate} disabled={props.busy}>Nova execução</button>
        <button className="primary" onClick={props.onStart} disabled={props.busy || snapshot.directions.length > 0}>
          {snapshot.directions.length > 0 ? 'Etapa executada' : props.busy ? 'Executando…' : 'Executar etapa de identidade'}
        </button>
      </div>

      {snapshot.divergence && <p className={snapshot.divergence.passed ? 'gate-check ok' : 'gate-check blocked'} role="status">
        {snapshot.divergence.passed
          ? `DIV-030 aprovado: cada par de direções difere em ${Math.min(...snapshot.divergence.pairs.map((pair) => pair.distinctAxes.length))} eixos ou mais.`
          : `DIV-030 bloqueia a seleção automática: ${snapshot.divergence.blockedPairs.join(' ')}`}
      </p>}

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

            <p className="version-line"><code>{direction.versionId}</code> ramo de <code>{direction.parentVersionId}</code>{direction.refinedFromVersionId ? ' · refinado uma vez' : ''}</p>

            {blockers.length > 0
              ? <ul className="blocker-list" aria-label={`Bloqueios de ${direction.label}`}>{blockers.map((item) => <li key={item}>{item}</li>)}</ul>
              : <p className="gate-check ok">Sem veto determinístico nem achado bloqueante.</p>}
            {direction.abstained && <p className="gate-check blocked">Um crítico respondeu “incerto”: a decisão sobe para o capitão.</p>}

            <div className="actions">
              <button className="secondary" onClick={() => props.onReject(direction.directionId, rationale || 'Direção devolvida para revisão.')} disabled={props.busy || closed}>Devolver</button>
              <button className="primary" onClick={() => props.onApprove(direction.directionId, rationale || `Gate 1: ${direction.label}.`, override || undefined)} disabled={props.busy || closed}>
                Aprovar esta direção
              </button>
            </div>
          </article>;
        })}
      </div>

      {snapshot.directions.length > 0 && !closed && <div className="gate-decision">
        <label htmlFor="gate-rationale">Motivo da decisão (fica registrado com o aprovador <strong>captain</strong>)</label>
        <textarea id="gate-rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} rows={2} placeholder="Por que esta direção responde ao briefing." />
        <label htmlFor="gate-override">Justificativa de override, obrigatória quando um check bloqueia a seleção automática</label>
        <textarea id="gate-override" value={override} onChange={(event) => setOverride(event.target.value)} rows={2} placeholder="Só preencher se houver bloqueio e a decisão for seguir mesmo assim." />
      </div>}

      {record && <div className="gate-record" role="status">
        <p><strong>Decisão registrada.</strong> {record.directionId} · versão <code>{record.versionId}</code> · hash da identidade <code>{record.identityHash.slice(0, 16)}…</code></p>
        <p>{record.rationale}</p>
        {snapshot.assets.length > 0 && <ul className="asset-list">{snapshot.assets.map((asset) => <li key={asset.id}>
          <code>{asset.id}</code> · {asset.status} · licença: {asset.provenance.license}
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

      {snapshot.failures.length > 0 && <ul className="blocker-list" aria-label="Falhas da execução">{snapshot.failures.map((failure) => <li key={failure.taskId}>{failure.taskId}: {failure.reason}</li>)}</ul>}
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
    case 'reopened': return 'reaberto';
    case 'failed': return 'falhou';
    default: return 'sem execução';
  }
}
