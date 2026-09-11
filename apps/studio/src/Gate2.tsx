import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { rememberedIdentityRun } from './identityRun.js';
import './gate2.css';

type Verdict = 'pass' | 'revise' | 'uncertain';
type IssueDecision = 'accepted' | 'rejected' | 'deferred';

interface ProposedPatch { operation: string; nodeId?: string; assetId?: string; prop?: string; token?: string; text?: string; minWidth?: string; order?: string[]; }

interface Issue {
  id: string; dimension: string; severity: string; observation: string; why: string; confidence: number;
  abstain: boolean; applied: boolean; refusal?: string; checks: string[];
  evidence: { route: string; viewport: number; state: string; colorScheme: 'light' | 'dark'; reducedMotion: boolean; nodeIds: string[] };
  patch?: ProposedPatch;
}

interface Report {
  dimension: string;
  perception: { summary: string; regions: Array<{ nodeId: string; role: string; note: string }> };
  comprehension: { hierarchy: string; intent: string; brandAlignment: string };
  projection: { verdict: Verdict; rubric: Array<{ criterion: string; score: number; evidence: string }>; findings: Issue[] };
}

/** The Gate 1 execution a run was seeded from; the whole point of the run is to measure that identity. */
interface Chain { identityRunId: string; identityVersionId: string; identityHash: string; projectId: string; seededImagery?: Array<{ id: string; status: 'generating' | 'placeholder' | 'ready' | 'failed'; note?: string }>; }

/** What the raster lane left on each approved image, in the captain's words. */
const imageryCopy: Record<string, string> = {
  ready: 'gerada pelo Gate 1',
  placeholder: 'sem provedor de imagem configurado',
  generating: 'ainda em geração quando esta revisão começou',
  failed: 'não foi gerada',
};

/**
 * The images live in the revision's ledger, not in its sections: this stage does
 * not place an image on a page yet, so they count for provenance and licensing
 * without appearing in the preview.
 */
const IMAGERY_NOTE = 'As imagens do Gate 1 ficam no registro e na licença desta revisão; esta etapa ainda não as posiciona nas seções.';

interface Progress {
  runId: string; status: 'queued' | 'running' | 'settled' | 'failed' | 'interrupted'; step: string; detail: string;
  startedAt: string; updatedAt: string; chain?: Chain; error?: string;
}

interface Result {
  identityHash: string;
  stopReason: string; stopDetail: string; gate: 'needs_review' | 'vetoed'; journey: string;
  before: { versionId: string; label: string }; after: { versionId: string; label: string }; repaired: boolean;
  routes: Array<{ route: string; title: string }>; viewports: number[]; states: string[]; colorSchemes: Array<'light' | 'dark'>;
  qa: Array<{ id: string; tier: number; severity: string; title: string; message: string; nodeIds: string[] }>;
  lint: Array<{ id: string; severity: string; path: string; message: string }>;
  cycles: Array<{ cycle: number; versionId: string; vetoes: number; rubricAverage: number; verdicts: Verdict[]; appliedFindingIds: string[]; rejectedCount: number }>;
  reports: Report[];
  issues: Issue[];
  decisions: Array<{ findingId: string; decision: IssueDecision; rationale: string; createdAt: string }>;
  approval?: { decision: 'approved' | 'rejected'; rationale: string; versionId: string; createdAt: string };
}

interface Snapshot extends Progress { result?: Result }

const GATE2_ROUTE = '#/gate-2';
const POLL_INTERVAL_MS = 1500;

/** The run under review is the one named in the URL, so a reload during a measurement finds it again. */
function runIdFromHash(): string {
  const hash = window.location.hash;
  return hash.startsWith(`${GATE2_ROUTE}/`) ? decodeURIComponent(hash.slice(GATE2_ROUTE.length + 1)) : '';
}

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:4310';
const PREVIEW_ORIGIN = import.meta.env.VITE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:4311';
const FRAME_HEIGHT = 780;

const stopReasonCopy: Record<string, string> = {
  clean: 'Os quatro críticos aprovaram a revisão.',
  tier0_veto: 'O QA determinístico vetou antes de qualquer modelo.',
  max_cycles: 'A etapa atingiu o teto de ciclos.',
  repeated_issue: 'O mesmo problema voltou em duas rodadas.',
  improvement_below_noise: 'A melhoria ficou abaixo do ruído do juiz.',
  uncertain: 'Um crítico respondeu uncertain.',
  no_actionable_patch: 'Nenhum reparo aplicável nesta rodada.',
  budget_exhausted: 'O orçamento da etapa acabou.',
};
const dimensionCopy: Record<string, string> = {
  narrative: 'Narrativa e hierarquia', responsiveness: 'Transformação responsiva',
  'a11y-interaction': 'Acessibilidade e interação', coherence: 'Coerência e genericidade',
};
const decisionCopy: Record<IssueDecision, string> = { accepted: 'Aceito', rejected: 'Rejeitado', deferred: 'Adiado' };
const statusCopy: Record<Progress['status'], string> = {
  queued: 'Na fila da medição…', running: 'Medindo o protótipo no navegador…', settled: 'Pronto para a decisão do capitão',
  failed: 'A execução falhou', interrupted: 'A execução foi interrompida',
};
const isActive = (status: Progress['status']): boolean => status === 'queued' || status === 'running';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'Não foi possível concluir a ação.');
  return payload;
}

function describePatch(patch: ProposedPatch | undefined): string {
  if (!patch) return 'sem reparo proposto';
  if (patch.operation === 'set_token') return `set_token · ${patch.nodeId}.${patch.prop} → ${patch.token}`;
  if (patch.operation === 'replace_copy') return `replace_copy · ${patch.nodeId} → "${patch.text}"`;
  if (patch.operation === 'set_constraint') return `set_constraint · ${patch.nodeId} a partir de ${patch.minWidth}: ${patch.prop} → ${patch.token}`;
  if (patch.operation === 'set_crop') return `set_crop · ${patch.assetId}`;
  if (patch.operation === 'reorder_node') return `reorder_node · ${patch.nodeId} → ${(patch.order ?? []).join(' › ')}`;
  return patch.operation;
}

/** Two revisions of the same route at the same width, scaled to whatever room the panel has. */
function Compare(props: { mode: 'side' | 'overlay' | 'difference'; viewport: number; before: string; after: string; route: string }): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  // A comparison is only a comparison while both panes hold the same route, so a pane that navigates
  // itself — the composed call to action is a real anchor — sends both back to the selected route.
  const [pin, setPin] = useState(0);
  const expectedLoads = useRef(0);
  // Two narrow viewports fit next to each other; a wide one is only readable stacked.
  const columns = props.mode === 'side' && props.viewport <= 768 ? 2 : 1;

  useLayoutEffect(() => { expectedLoads.current = 2; }, [props.before, props.after, props.route, pin]);

  const onLoad = (): void => {
    if (expectedLoads.current > 0) { expectedLoads.current -= 1; return; }
    setPin((value) => value + 1);
  };

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = (): void => {
      const available = (element.clientWidth - (columns - 1) * 16) / columns;
      setScale(Math.min(1, available / props.viewport));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [columns, props.viewport]);

  const frame = (versionId: string, label: string, layer: 'base' | 'top'): ReactElement => (
    <div className={`compare-slot ${layer}`} key={`${versionId}-${layer}-${pin}`} style={{ width: props.viewport * scale, height: FRAME_HEIGHT * scale }}>
      <iframe
        title={`Preview ${label} — ${props.route}`}
        src={`${PREVIEW_ORIGIN}/preview/${encodeURIComponent(versionId)}${props.route}`}
        sandbox=""
        width={props.viewport}
        height={FRAME_HEIGHT}
        style={{ transform: `scale(${scale})` }}
        onLoad={onLoad}
      />
      <span className="compare-label">{label}</span>
    </div>
  );

  return (
    <div className={`compare compare-${props.mode}`} ref={container} data-columns={columns}>
      {frame(props.before, 'A', 'base')}
      {frame(props.after, 'B', 'top')}
    </div>
  );
}

export default function Gate2(): ReactElement {
  const [runId, setRunId] = useState(runIdFromHash);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [recent, setRecent] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [route, setRoute] = useState('/');
  const [viewport, setViewport] = useState(1440);
  const [mode, setMode] = useState<'side' | 'overlay' | 'difference'>('side');
  const [lens, setLens] = useState<'perception' | 'comprehension' | 'projection'>('projection');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [gateReason, setGateReason] = useState('');
  const identityRunId = rememberedIdentityRun();

  const adopt = useCallback((next: Snapshot): void => {
    setSnapshot(next);
    const routes = next.result?.routes ?? [];
    setRoute((current) => routes.some((entry) => entry.route === current) ? current : routes[0]?.route ?? '/');
  }, []);

  const act = useCallback(async (action: () => Promise<Snapshot>): Promise<void> => {
    setBusy(true); setError('');
    try { adopt(await action()); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Erro desconhecido.');
      // A refused decision usually means this tab is holding a snapshot someone
      // else already decided from, so the screen rereads what is true now.
      if (runId) {
        try { adopt(await request<Snapshot>(`/api/prototype/runs/${encodeURIComponent(runId)}`)); }
        catch { /* the refusal already says what happened */ }
      }
    }
    finally { setBusy(false); }
  }, [adopt, runId]);

  useEffect(() => { document.title = 'Gate 2 — protótipo'; }, []);

  useEffect(() => {
    const track = (): void => setRunId(runIdFromHash());
    window.addEventListener('hashchange', track);
    return () => window.removeEventListener('hashchange', track);
  }, []);

  // The run in the URL is polled until it settles, so the review survives a reload and a closed tab.
  useEffect(() => {
    if (!runId) { setSnapshot(null); return; }
    let live = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await request<Snapshot>(`/api/prototype/runs/${encodeURIComponent(runId)}`);
        if (!live) return;
        adopt(next);
        setError(next.error ?? '');
        if (isActive(next.status)) timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : 'Erro desconhecido.');
      }
    };
    void poll();
    return () => { live = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [runId, adopt]);

  // The entry screen keeps watching the queue, because a run holds the only measuring slot there is.
  useEffect(() => {
    if (runId) return;
    let live = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const payload = await request<{ runs: Progress[] }>('/api/prototype/runs');
        if (!live) return;
        setRecent(payload.runs);
        if (payload.runs.some((entry) => isActive(entry.status))) timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch { if (live) setRecent([]); }
    };
    void poll();
    return () => { live = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [runId]);

  const start = async (): Promise<void> => {
    setBusy(true); setError('');
    try {
      // The stage starts from the identity Gate 1 approved, named by the run the
      // captain decided it on. Without one the server refuses: there is nothing
      // to prototype until an identity is approved.
      const created = await request<Snapshot>('/api/prototype/runs', { method: 'POST', body: JSON.stringify({ approverRole: 'captain', runId: `gate2-${Date.now()}`, identityRunId: rememberedIdentityRun() }) });
      window.location.hash = `${GATE2_ROUTE}/${encodeURIComponent(created.runId)}`;
      setRunId(created.runId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Erro desconhecido.'); }
    finally { setBusy(false); }
  };
  const decide = async (runId: string, findingId: string, decision: IssueDecision): Promise<void> => act(() => request<Snapshot>(`/api/prototype/runs/${runId}/decision`, {
    method: 'POST', body: JSON.stringify({ approverRole: 'captain', findingId, decision, rationale: reasons[findingId]?.trim() || `${decisionCopy[decision]} sem observação adicional do capitão.` }),
  }));
  const settle = async (runId: string, decision: 'approved' | 'rejected'): Promise<void> => act(() => request<Snapshot>(`/api/prototype/runs/${runId}/gate`, {
    method: 'POST', body: JSON.stringify({ approverRole: 'captain', decision, rationale: gateReason.trim() || (decision === 'approved' ? 'Protótipo aprovado pelo capitão.' : 'Protótipo devolvido para revisão.') }),
  }));

  const result = snapshot?.result;
  const decided = useMemo(() => new Map((result?.decisions ?? []).map((entry) => [entry.findingId, entry])), [result]);
  const vetoes = result?.qa.filter((check) => check.severity === 'veto') ?? [];

  if (!snapshot) {
    const active = recent.find((entry) => isActive(entry.status));
    return (
      <div className="gate2-shell">
        <header className="gate2-top">
          <div><p className="eyebrow">Gate 02 · protótipo</p><h1>Hierarquia, comportamento e caráter</h1></div>
          <a className="gate2-back" href="#/">← pipeline</a>
        </header>
        <section className="gate2-intro">
          <p>O protótipo é composto por agentes em paralelo sobre a identidade congelada, verificado por checagens determinísticas antes de qualquer modelo, e criticado por quatro sessões separadas. Nada roda até você pedir.</p>
          <p>A etapa mede cada revisão num navegador real, então leva minutos. A execução fica no endereço desta página: recarregar não perde a revisão, e reiniciar o servidor também não.</p>
          <p className="gate2-chain">{identityRunId ? <>Esta execução parte da identidade aprovada no Gate 1 <code>{identityRunId}</code>.</> : <>Nenhum Gate 1 decidido neste navegador: <a href="#/">aprove uma identidade</a> antes de medir o protótipo.</>}</p>
          <button className="primary" onClick={() => void start()} disabled={busy || active !== undefined}>{busy ? 'Abrindo a execução…' : active ? 'Uma execução já está em andamento' : 'Executar a etapa de protótipo'}</button>
          {active && <p className="gate2-note">O servidor mede uma revisão por vez. <a href={`${GATE2_ROUTE}/${encodeURIComponent(active.runId)}`}>Acompanhe {active.runId}</a>.</p>}
          {recent.length > 0 && (
            <div className="gate2-runs">
              <p className="eyebrow">Histórico de execuções</p>
              <ul>
                {recent.map((entry) => (
                  <li key={entry.runId}>
                    <a href={`${GATE2_ROUTE}/${encodeURIComponent(entry.runId)}`}><code>{entry.runId}</code></a>
                    <span className={`status status-${entry.status}`}>{statusCopy[entry.status]}</span>
                    <small>{entry.detail}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && <p className="error-banner" role="alert">{error}</p>}
        </section>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="gate2-shell">
        <header className="gate2-top">
          <div><p className="eyebrow">Gate 02 · protótipo · {snapshot.runId}</p><h1>{statusCopy[snapshot.status]}</h1></div>
          <a className="gate2-back" href={GATE2_ROUTE}>← execuções</a>
        </header>
        <section className="gate2-intro">
          <p role="status">{snapshot.detail}</p>
          <p className="gate2-note">Passo atual: <code>{snapshot.step}</code> · início {new Date(snapshot.startedAt).toLocaleTimeString('pt-BR')}</p>
          <p>Cada revisão é capturada num navegador real em 390, 768 e 1440 px, em cada estado declarado, antes que qualquer crítico opine. Esta página acompanha sozinha; o endereço guarda a execução.</p>
          {(snapshot.status === 'failed' || snapshot.status === 'interrupted') && <p className="error-banner" role="alert">{snapshot.error ?? snapshot.detail}</p>}
          {error && <p className="error-banner" role="alert">{error}</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="gate2-shell">
      <header className="gate2-top">
        <div>
          <p className="eyebrow">Gate 02 · protótipo · {snapshot.runId}</p>
          <h1>{result.journey}</h1>
        </div>
        <div className="gate2-badges">
          {snapshot.chain && <span className={`qa-chip${result.identityHash === snapshot.chain.identityHash ? '' : ' identity-mismatch'}`} title={`Gate 1 · ${snapshot.chain.identityRunId}`}>{result.identityHash === snapshot.chain.identityHash ? 'identidade do Gate 1 medida nesta revisão' : 'a identidade desta revisão não é a do Gate 1'}</span>}
          {snapshot.chain?.seededImagery?.map((asset) => (
            <span key={asset.id} className={`qa-chip${asset.status === 'ready' ? '' : ' identity-mismatch'}`} title={asset.note ? `${asset.note}\n${IMAGERY_NOTE}` : IMAGERY_NOTE}>{asset.id}: {imageryCopy[asset.status] ?? asset.status}</span>
          ))}
          <span className={`status status-${result.gate}`}>{result.gate === 'vetoed' ? 'vetado pelo QA' : 'aguarda decisão'}</span>
          <span className="qa-chip" title={result.stopDetail}>parou por: {stopReasonCopy[result.stopReason] ?? result.stopReason}</span>
          <a className="gate2-back" href="#/">← pipeline</a>
        </div>
      </header>

      <div className="gate2-grid">
        <section className="gate2-compare-panel">
          <div className="gate2-controls">
            <div className="route-tabs">
              {result.routes.map((entry) => (
                <button key={entry.route} className={route === entry.route ? 'selected' : ''} onClick={() => setRoute(entry.route)}>{entry.route}</button>
              ))}
              <small>Estas abas são a única navegação daqui: um link seguido dentro da comparação volta para a rota selecionada.</small>
            </div>
            <div className="gate2-selects">
              <label>Largura
                <select value={viewport} onChange={(event) => setViewport(Number(event.target.value))}>
                  {result.viewports.map((width) => <option key={width} value={width}>{width}px</option>)}
                </select>
              </label>
              <div className="gate2-modes" role="group" aria-label="Modo de comparação">
                {([['side', 'lado a lado'], ['overlay', 'sobreposição'], ['difference', 'diferença']] as const).map(([id, label]) => (
                  <button key={id} className={mode === id ? 'selected' : ''} onClick={() => setMode(id)}>{label}</button>
                ))}
              </div>
            </div>
          </div>
          <p className="gate2-versions">
            <strong>{result.before.label}</strong> <code>{result.before.versionId}</code>
            {' · '}<strong>{result.after.label}</strong> <code>{result.after.versionId}</code>
            {!result.repaired && <> · nenhum reparo foi aplicado, então os dois lados são a mesma revisão e a diferença é vazia</>}
          </p>
          <Compare mode={mode} viewport={viewport} before={result.before.versionId} after={result.after.versionId} route={route} />
        </section>

        <section className="gate2-evidence">
          <div className="gate2-block">
            <h2>QA determinístico</h2>
            <p className="gate2-note">
              {vetoes.length > 0 ? `${vetoes.length} veto(s) impedem a promoção. ` : 'Tier 0 passou sem veto. '}
              {result.qa.length > 12 ? `Mostrando 12 de ${result.qa.length} observações; role a lista.` : `${result.qa.length} observação(ões) no total.`}
            </p>
            <ul className="gate2-checks">
              {result.qa.length === 0 && <li className="clean">Nenhuma observação determinística.</li>}
              {result.qa.slice(0, 12).map((check, index) => (
                <li key={`${check.id}-${index}`} className={check.severity}>
                  <span className="tag">T{check.tier} · {check.id}</span>
                  <span>{check.message}</span>
                  {check.nodeIds.length > 0 && <code>{check.nodeIds.join(', ')}</code>}
                </li>
              ))}
            </ul>
          </div>

          <div className="gate2-block">
            <h2>Opinião dos críticos</h2>
            <div className="gate2-modes" role="group" aria-label="Camada da crítica">
              {([['perception', 'percepção'], ['comprehension', 'compreensão'], ['projection', 'projeção']] as const).map(([id, label]) => (
                <button key={id} className={lens === id ? 'selected' : ''} onClick={() => setLens(id)}>{label}</button>
              ))}
            </div>
            {result.reports.map((report) => (
              <article className="gate2-critic" key={report.dimension}>
                <header>
                  <strong>{dimensionCopy[report.dimension] ?? report.dimension}</strong>
                  <span className={`verdict verdict-${report.projection.verdict}`}>{report.projection.verdict}</span>
                </header>
                {lens === 'perception' && <p>{report.perception.summary}</p>}
                {lens === 'comprehension' && <p>{report.comprehension.hierarchy} · {report.comprehension.brandAlignment}</p>}
                {lens === 'projection' && (
                  <ul className="gate2-rubric">
                    {report.projection.rubric.map((entry) => (
                      <li key={entry.criterion} className={entry.score < 3 ? 'below' : ''}><span>{entry.criterion}</span><b>{entry.score}/4</b></li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="gate2-issues">
          <div className="section-heading">
            <div><p className="eyebrow">Achados</p><h2>Cada issue traz nó, evidência e o reparo proposto</h2></div>
            <span className="qa-chip">{result.issues.length} achado(s) · {result.decisions.length} decidido(s)</span>
          </div>
          {result.issues.length === 0 && <p className="gate2-note">Nenhum crítico encontrou algo a reparar nesta revisão.</p>}
          <div className="gate2-issue-list">
            {result.issues.map((issue) => {
              const record = decided.get(issue.id);
              return (
                <article className={`gate2-issue severity-${issue.severity}`} key={issue.id}>
                  <header>
                    <span className="tag">{dimensionCopy[issue.dimension] ?? issue.dimension}</span>
                    <span className={`severity severity-${issue.severity}`}>{issue.severity}</span>
                    <span className="confidence">confiança {(issue.confidence * 100).toFixed(0)}%</span>
                  </header>
                  <p className="observation">{issue.observation}</p>
                  <p className="why">{issue.why}</p>
                  <dl>
                    <div><dt>nós</dt><dd><code>{issue.evidence.nodeIds.join(', ')}</code></dd></div>
                    <div><dt>evidência</dt><dd>{issue.evidence.route} · {issue.evidence.viewport}px · {issue.evidence.state} · {issue.evidence.colorScheme}</dd></div>
                    <div><dt>reparo</dt><dd><code>{describePatch(issue.patch)}</code></dd></div>
                    <div><dt>situação</dt><dd>{issue.applied ? 'aplicado nesta rodada' : issue.refusal ?? (issue.abstain ? 'crítico se absteve; decisão humana' : 'não aplicado')}</dd></div>
                  </dl>
                  {record ? (
                    <p className="gate2-decided">{decisionCopy[record.decision]} · {record.rationale}</p>
                  ) : (
                    <div className="gate2-decide">
                      <label className="sr-only" htmlFor={`reason-${issue.id}`}>Motivo da decisão sobre {issue.id}</label>
                      <input id={`reason-${issue.id}`} placeholder="Motivo da decisão" value={reasons[issue.id] ?? ''} onChange={(event) => setReasons((current) => ({ ...current, [issue.id]: event.target.value }))} />
                      <button className="primary" disabled={busy} onClick={() => void decide(snapshot.runId, issue.id, 'accepted')}>Aceitar</button>
                      <button className="secondary" disabled={busy} onClick={() => void decide(snapshot.runId, issue.id, 'rejected')}>Rejeitar</button>
                      <button className="secondary" disabled={busy} onClick={() => void decide(snapshot.runId, issue.id, 'deferred')}>Adiar</button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          <div className="gate2-final">
            <label className="sr-only" htmlFor="gate-reason">Motivo da decisão do gate</label>
            <input id="gate-reason" placeholder="Motivo da decisão do gate" value={gateReason} onChange={(event) => setGateReason(event.target.value)} />
            <button className="secondary" disabled={busy || Boolean(result.approval)} onClick={() => void settle(snapshot.runId, 'rejected')}>Devolver para revisão</button>
            <button className="primary" disabled={busy || result.gate === 'vetoed' || Boolean(result.approval)} onClick={() => void settle(snapshot.runId, 'approved')}>Aprovar o Gate 2</button>
          </div>
          {result.approval && <p className="gate2-decided" role="status">Gate {result.approval.decision === 'approved' ? 'aprovado' : 'devolvido'} em {result.approval.versionId} · {result.approval.rationale}</p>}
          {error && <p className="error-banner" role="alert">{error}</p>}
        </section>
      </div>
    </div>
  );
}
