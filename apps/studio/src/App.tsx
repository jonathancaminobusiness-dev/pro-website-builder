import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Gate2 from './Gate2.js';
import Gate3Panel from './Gate3Panel.js';
import IdentityGate, { type IdentityGateSnapshot } from './gate1/IdentityGate.js';
import { forgetIdentityRun, rememberedIdentityRun, rememberIdentityRun } from './identityRun.js';
import { failureMessage, isMissing, RequestError, requestJson } from './request.js';

interface Snapshot {
  runId: string;
  projectId: string;
  status: 'queued' | 'needs_review' | 'rejected' | 'cancelled' | 'succeeded' | 'failed';
  currentStage: 'identity' | 'prototype' | 'finalization' | null;
  currentVersion: { id: string; hash: string };
  rendered: { routes: Array<{ route: string; title: string; html: string }> };
  approvals: Array<{ stage: string; decision: string; versionId: string }>;
  /** The release gate's own verdict on this run's document; the screen never re-derives it. */
  releaseGate: { prototypeVersionId?: string; blocker?: string };
  exportManifest?: { digest: string; routes: Array<{ route: string; path: string }> };

  lintErrorCount: number;
}

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:4310';
const PREVIEW_ORIGIN = import.meta.env.VITE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:4311';
const stages = [{ id: 'identity', label: '01 Identidade' }, { id: 'prototype', label: '02 Protótipo' }, { id: 'finalization', label: '03 Finalização' }] as const;
const views = [{ id: 'pipeline', label: 'Pipeline' }, { id: 'gate1', label: 'Gate 1 · identidade' }] as const;
type ViewId = (typeof views)[number]['id'];


async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(`${API_ORIGIN}${path}`, init);
}

const GATE2_ROUTE = '#/gate-2';

/** How many consecutive reads may fail before the screen stops following a queued, recovering, or working run. */
const POLL_MAX_FAILURES = 10;

interface IdentityReadSource {
  generation: number;
  epoch: number;
  kind: 'read' | 'action';
}

interface IdentityActOptions {
  manageBusy?: boolean;
  source?: IdentityReadSource;
  shouldAccept?: (next: IdentityGateSnapshot) => boolean;
  onFailure?: (cause: unknown) => void;
}

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [route, setRoute] = useState('/');
  const [view, setView] = useState<ViewId>('pipeline');
  const [identity, setIdentity] = useState<IdentityGateSnapshot | null>(null);
  const [identityError, setIdentityError] = useState('');
  /** The remembered run the screen is holding because the last read of it did not answer. */
  const [unreachableRunId, setUnreachableRunId] = useState('');
  const [pollFailures, setPollFailures] = useState({ runId: '', count: 0 });
  const [pollTick, setPollTick] = useState(0);
  /**
   * The tab that issued the start keeps a local pending guard while its own
   * snapshot is still the one from before the request. It does not change the
   * server-derived badge; it keeps cancellation available until the server
   * confirms the next state. A `running` snapshot offers the same stop in every
   * tab, including this one after a reload.
   */
  const [startingRun, setStartingRun] = useState(false);
  /**
   * The run Gate 3 compiles. Once Gate 1 closed, that is the chain the captain
   * actually worked on — the identity execution, whose ledger also holds the
   * Gate 2 approval recorded on a descendant of it — and not the fixed briefing.
   */
  const [chainRun, setChainRun] = useState<Snapshot | null>(null);
  const [chainError, setChainError] = useState('');
  const [chainBusy, setChainBusy] = useState(false);
  const [startRecoveryRunId, setStartRecoveryRunId] = useState('');
  const [recoveryExhaustedRunId, setRecoveryExhaustedRunId] = useState('');
  const startEpoch = useRef(0);
  const identityGeneration = useRef(0);
  const recoveryAttempts = useRef({ runId: '', count: 0 });
  const pendingStart = useRef<{ runId: string; epoch: number } | null>(null);
  const latestIdentity = useRef<IdentityGateSnapshot | null>(null);
  const previewUrl = useMemo(() => snapshot ? `${PREVIEW_ORIGIN}/preview/${encodeURIComponent(snapshot.currentVersion.id)}${route}` : '', [route, snapshot]);

  useEffect(() => {
    const track = (): void => setHash(window.location.hash);
    window.addEventListener('hashchange', track);
    return () => window.removeEventListener('hashchange', track);
  }, []);

  async function act(action: () => Promise<Snapshot>): Promise<void> {
    setBusy(true); setError('');
    try { setSnapshot(await action()); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Erro desconhecido.'); } finally { setBusy(false); }
  }

  const create = () => act(async () => (await request<{ snapshot: Snapshot; runId: string }>('/api/runs', { method: 'POST', body: JSON.stringify({ runId: `studio-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }) })).snapshot);

  const acceptIdentityRun = useCallback((next: IdentityGateSnapshot, source: IdentityReadSource = { generation: identityGeneration.current, epoch: startEpoch.current, kind: 'action' }): boolean => {
    if (source.generation !== identityGeneration.current) return false;
    if (source.kind === 'read' && source.epoch < startEpoch.current) return false;
    if (latestIdentity.current?.runId === next.runId && latestIdentity.current.status !== 'queued' && next.status === 'queued') return false;
    const localStart = pendingStart.current;
    const previousIdentity = latestIdentity.current;
    const unchangedRecoveryTerminal = source.kind === 'read' && previousIdentity?.runId === next.runId && previousIdentity.status === next.status && (next.status === 'failed' || next.status === 'interrupted');
    if (source.kind === 'read' && localStart?.runId === next.runId && localStart.epoch === source.epoch && latestIdentity.current?.runId === next.runId && latestIdentity.current.status === next.status) return false;
    if (localStart?.runId === next.runId && next.status !== 'queued') {
      pendingStart.current = null;
      startEpoch.current += 1;
      setStartingRun(false);
    }
    setUnreachableRunId('');
    setPollFailures({ runId: next.runId, count: 0 });
    setRecoveryExhaustedRunId((current) => current === next.runId ? '' : current);
    setStartRecoveryRunId((current) => current === next.runId && !unchangedRecoveryTerminal && (next.status !== 'queued' || source.kind === 'action') ? '' : current);
    setIdentityError('');
    latestIdentity.current = next;
    setIdentity(next);
    return true;
  }, []);

  const identityAct = useCallback(async (action: () => Promise<IdentityGateSnapshot>, options: IdentityActOptions = {}): Promise<IdentityGateSnapshot | undefined> => {
    const source: IdentityReadSource = options.source ?? (() => {
      const epoch = startEpoch.current + 1;
      startEpoch.current = epoch;
      return { generation: identityGeneration.current, epoch, kind: 'action' as const };
    })();
    const manageBusy = options.manageBusy !== false;
    if (manageBusy) setBusy(true);
    setIdentityError('');
    try {
      const next = await action();
      if (options.shouldAccept?.(next) ?? true) {
        if (acceptIdentityRun(next, source)) rememberIdentityRun(next.runId);
      }
      return next;
    } catch (cause) {
      if (source.generation === identityGeneration.current && (source.kind !== 'action' || source.epoch === startEpoch.current)) setIdentityError(failureMessage(cause));
      options.onFailure?.(cause);
      return undefined;
    } finally { if (manageBusy && source.generation === identityGeneration.current) setBusy(false); }
  }, [acceptIdentityRun]);
  const identityGet = useCallback((runId: string) => request<IdentityGateSnapshot>(`/api/identity/runs/${encodeURIComponent(runId)}`), []);
  const restoreIdentityGeneration = useCallback((generation: number, previousGeneration: number): void => {
    if (identityGeneration.current !== generation) return;
    identityGeneration.current = previousGeneration;
    setBusy(false);
    setPollTick((current) => current + 1);
  }, []);
  const openIdentityRun = useCallback((runId: string) => {
    const previousGeneration = identityGeneration.current;
    const generation = identityGeneration.current + 1;
    identityGeneration.current = generation;
    const source: IdentityReadSource = { generation, epoch: startEpoch.current, kind: 'read' };
    void identityAct(() => identityGet(runId), { source, onFailure: () => restoreIdentityGeneration(generation, previousGeneration) });
  }, [identityAct, identityGet, restoreIdentityGeneration]);

  // Only a run the server no longer knows is forgotten. A server that is not
  // listening yet says nothing about whether the run exists, and the id is the
  // captain's one pointer back to a decided gate, so it is held and shown
  // instead of being replaced by the screen that offers to start a new one.
  const readRememberedRun = useCallback((): void => {
    const remembered = rememberedIdentityRun();
    if (!remembered) { setUnreachableRunId(''); return; }
    const generation = identityGeneration.current + 1;
    identityGeneration.current = generation;
    setRecoveryExhaustedRunId((current) => current === remembered ? '' : current);
    setBusy(true); setIdentityError('');
    const source: IdentityReadSource = { generation, epoch: startEpoch.current, kind: 'read' };
    void identityGet(remembered).then(
      (next) => { acceptIdentityRun(next, source); },
      (cause: unknown) => {
        if (source.generation !== identityGeneration.current) return;
        if (isMissing(cause)) { forgetIdentityRun(); setUnreachableRunId(''); return; }
        setUnreachableRunId(remembered);
        setIdentityError(failureMessage(cause));
      },
    ).finally(() => { if (source.generation === identityGeneration.current) setBusy(false); });
  }, [acceptIdentityRun, identityGet]);

  useEffect(() => { readRememberedRun(); }, [readRememberedRun]);

  // The screen follows queued or working runs: the fan-out while the stage
  // runs, then the raster lane until every asset has settled. An ambiguous
  // start also gets bounded recovery reads. A read that failed is retried,
  // because the server may be restarting mid-shoot, but only so many times: a
  // run that is gone, or a server that never comes back, ends the loop and says
  // so rather than being polled in silence for the rest of the session.
  const generating = identity?.assets.some((asset) => asset.status === 'generating') ?? false;
  const running = identity?.status === 'running';
  const queued = identity?.status === 'queued';
  const startRecoveryPending = startRecoveryRunId === identity?.runId;
  const recoveryExhausted = recoveryExhaustedRunId === identity?.runId;
  const executionInFlight = startingRun || generating || running;
  const following = (queued && !recoveryExhausted) || executionInFlight || startRecoveryPending;
  // The budget belongs to the run it was spent on, so a run that went away
  // cannot leave a later one looking as if its images never settled.
  const spent = identity && pollFailures.runId === identity.runId ? pollFailures.count : 0;
  useEffect(() => {
    if (!identity || !following || spent >= POLL_MAX_FAILURES) return;
    // A reading of a run the screen has left cannot rewrite what is on it now.
    let dropped = false;
    const runId = identity.runId;
    const source: IdentityReadSource = { generation: identityGeneration.current, epoch: startEpoch.current, kind: 'read' };
    const timer = setTimeout(() => {
      if (source.generation !== identityGeneration.current) return;
      let recoveryAttempt = 0;
      if (startRecoveryPending) {
        recoveryAttempt = recoveryAttempts.current.runId === runId ? recoveryAttempts.current.count + 1 : 1;
        recoveryAttempts.current = { runId, count: recoveryAttempt };
      }
      void identityGet(runId).then(
        (next) => {
          if (dropped) return;
          const previousIdentity = latestIdentity.current;
          const unchangedRecovery = startRecoveryPending && previousIdentity?.runId === runId && previousIdentity.status === next.status && (next.status === 'queued' || next.status === 'failed' || next.status === 'interrupted');
          if (!acceptIdentityRun(next, source)) {
            if (source.generation === identityGeneration.current) setPollTick((current) => current + 1);
            return;
          }
          if (startRecoveryPending) {
            if (unchangedRecovery && recoveryAttempt >= POLL_MAX_FAILURES) {
              setStartRecoveryRunId((current) => current === runId ? '' : current);
              setRecoveryExhaustedRunId(runId);
              setIdentityError('Não foi possível confirmar o início. Tente novamente ou recarregue para ler o estado atual.');
            } else if (!unchangedRecovery) {
              recoveryAttempts.current = { runId, count: 0 };
            }
          }
        },
        (cause: unknown) => {
          if (dropped) return;
          if (source.generation !== identityGeneration.current) return;
          if (isMissing(cause)) {
            forgetIdentityRun();
            setStartRecoveryRunId((current) => current === runId ? '' : current);
            if (pendingStart.current?.runId === runId) {
              pendingStart.current = null;
              startEpoch.current += 1;
              setStartingRun(false);
            }
            recoveryAttempts.current = { runId, count: 0 };
            setRecoveryExhaustedRunId((current) => current === runId ? '' : current);
            setPollFailures({ runId, count: POLL_MAX_FAILURES });
            setIdentityError('Esta execução não está mais no servidor.');
            return;
          }
          const count = spent + 1;
          setPollFailures({ runId, count });
          if (count >= POLL_MAX_FAILURES) {
            if (startRecoveryPending) {
              recoveryAttempts.current = { runId, count: POLL_MAX_FAILURES };
              setStartRecoveryRunId((current) => current === runId ? '' : current);
              setRecoveryExhaustedRunId(runId);
              setIdentityError('Não foi possível confirmar o início. Tente novamente ou recarregue para ler o estado atual.');
            } else {
              setIdentityError('Não foi possível acompanhar esta execução. Recarregue para ler o estado atual.');
            }
          }
        },
      );
    }, 1500);
    return () => { dropped = true; clearTimeout(timer); };
  }, [acceptIdentityRun, following, identity, identityGet, pollTick, queued, running, spent, startRecoveryPending, startingRun]);
  // Gate 1 hands the chain on under the identity execution's own id: the
  // approvals of all three gates are recorded against it, so that id is what
  // Gate 3 prepares and publishes. A handoff the identity moved past hands
  // nothing on until the captain approves the identity again — but it stays the
  // chain this screen is about, so the finalization panel keeps pointing at it.
  const chainRunId = identity?.handoff ? identity.runId : '';
  const chainStale = identity?.handoff?.stale ?? false;
  useEffect(() => {
    if (!chainRunId) { setChainRun(null); setChainError(''); return; }
    let live = true;
    void request<Snapshot>(`/api/runs/${encodeURIComponent(chainRunId)}`).then(
      (next) => { if (live) { setChainRun(next); setChainError(''); } },
      (cause: unknown) => { if (live) { setChainRun(null); setChainError(failureMessage(cause)); } },
    );
    return () => { live = false; };
    // The hash is in here because Gate 2 is a route of this same screen: coming
    // back from a decision there has to read the chain again, or the line and
    // its button would still describe the run as it was before the decision.
  }, [chainRunId, identity?.handoff?.versionId, hash]);
  // Which decisions count is a fact about the version graph, which this screen
  // does not hold: the gate's own verdict travels on the snapshot.
  const chainGate = chainRun?.releaseGate;
  const prototypeVersionId = chainGate?.prototypeVersionId;
  const runChainStage = (): void => {
    if (!chainRunId) return;
    setChainBusy(true); setChainError('');
    void request<Snapshot>(`/api/runs/${encodeURIComponent(chainRunId)}/stage`, { method: 'POST' }).then(
      (next) => setChainRun(next),
      (cause: unknown) => setChainError(failureMessage(cause)),
    ).finally(() => setChainBusy(false));
  };
  const identityPost = (path: string, payload: Record<string, unknown> = {}) => request<IdentityGateSnapshot>(path, { method: 'POST', body: JSON.stringify({ approverRole: 'captain', ...payload }) });
  const createIdentityRun = (briefing?: string) => {
    const previousGeneration = identityGeneration.current;
    const generation = identityGeneration.current + 1;
    identityGeneration.current = generation;
    return identityAct(() => identityPost('/api/identity/runs', { runId: `identity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...(briefing === undefined ? {} : { briefing }) }), { source: { generation, epoch: startEpoch.current, kind: 'action' }, onFailure: () => restoreIdentityGeneration(generation, previousGeneration) });
  };
  const startIdentityRun = (): void => {
    if (!identity) return;
    const runId = identity.runId;
    const generation = identityGeneration.current;
    const epoch = startEpoch.current + 1;
    startEpoch.current = epoch;
    pendingStart.current = { runId, epoch };
    recoveryAttempts.current = { runId, count: 0 };
    setRecoveryExhaustedRunId((current) => current === runId ? '' : current);
    setStartRecoveryRunId('');
    setPollFailures({ runId, count: 0 });
    setStartingRun(true);
    void identityAct(() => identityPost(`/api/identity/runs/${runId}/start`), {
      manageBusy: false,
      source: { generation, epoch, kind: 'action' },
      shouldAccept: (next) => identityGeneration.current === generation && pendingStart.current?.runId === runId && pendingStart.current.epoch === epoch && latestIdentity.current?.runId === runId,
      onFailure: (cause) => {
        if (identityGeneration.current !== generation || pendingStart.current?.runId !== runId || pendingStart.current.epoch !== epoch) return;
        if (!(cause instanceof RequestError) || cause.status === undefined) {
          setPollFailures({ runId, count: 0 });
          setStartRecoveryRunId(runId);
        }
      },
    }).then(() => {
      if (identityGeneration.current !== generation || pendingStart.current?.runId !== runId || pendingStart.current.epoch !== epoch) return;
      pendingStart.current = null;
      startEpoch.current += 1;
      setStartingRun(false);
    });
  };
  const cancelIdentityRun = (): void => { if (identity) void identityAct(() => identityPost(`/api/identity/runs/${identity.runId}/cancel`)); };
  const approveDirection = (directionId: string, rationale: string, overrideRationale?: string) => identity && identityAct(() => identityPost(`/api/identity/runs/${identity.runId}/approve`, { directionId, rationale, ...(overrideRationale ? { overrideRationale } : {}) }));
  const rejectDirection = (directionId: string, rationale: string) => identity && identityAct(() => identityPost(`/api/identity/runs/${identity.runId}/reject`, { directionId, rationale }));
  const changeIdentityToken = (tokenPath: string, value: string) => identity && identityAct(() => identityPost(`/api/identity/runs/${identity.runId}/token`, { tokenPath, value, rationale: 'Mudança de token pedida pelo capitão depois do gate.' }));
  const runStage = () => snapshot && act(async () => request<Snapshot>(`/api/runs/${snapshot.runId}/stage`, { method: 'POST' }));
  const review = (decision: 'approve' | 'reject') => snapshot && act(async () => request<Snapshot>(`/api/runs/${snapshot.runId}/${decision}`, { method: 'POST', body: JSON.stringify({ approverRole: 'captain', stage: snapshot.currentStage, rationale: decision === 'approve' ? 'Gate aprovado pelo capitão.' : 'Revisar a proposta antes de continuar.' }) }));

  if (hash === GATE2_ROUTE || hash.startsWith(`${GATE2_ROUTE}/`)) return <Gate2 />;

  return <div className="studio-shell">
    <header className="topbar"><div><span className="eyebrow">FIRSTMATE / STUDIO LOCAL</span><h1>Compilador de identidade</h1></div><nav className="view-tabs" aria-label="Telas do estúdio">{views.map((item) => <button key={item.id} className={view === item.id ? 'selected' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}>{item.label}</button>)}</nav><span className="local-pill">uso próprio · pt-BR</span><a className="gate2-link" href={GATE2_ROUTE}>Gate 2 · revisão do protótipo →</a></header>
    {view === 'gate1' ? <main className="workspace workspace-single"><IdentityGate snapshot={identity} busy={busy} error={identityError} unreachableRunId={unreachableRunId} onCreate={createIdentityRun} onOpen={openIdentityRun} onRetry={readRememberedRun} onStart={startIdentityRun} onCancel={cancelIdentityRun} inFlight={executionInFlight} startRecoveryPending={startRecoveryPending} onApprove={approveDirection} onReject={rejectDirection} onChangeToken={changeIdentityToken} previewOrigin={PREVIEW_ORIGIN} /></main> : <main className="workspace">
      <section className="intro-panel"><p className="eyebrow">A identidade é o contrato</p><h2>Da direção visual ao site final, uma fonte de verdade.</h2><p>O editor mostra propostas tipadas; o renderer determinístico cuida do resultado. Os três gates desta versão são do capitão.</p><button className="primary" onClick={create} disabled={busy}>{busy ? 'Preparando…' : snapshot ? 'Reiniciar briefing' : 'Carregar briefing fixo'}</button></section>
      <section className="stage-panel"><div className="section-heading"><div><p className="eyebrow">Pipeline</p><h2>Três etapas, três decisões</h2></div>{snapshot && <span className={`status status-${snapshot.status}`}>{snapshot.status === 'needs_review' ? 'aguarda gate' : snapshot.status === 'rejected' ? 'rejeitado · reexecutar' : snapshot.status}</span>}</div><div className="stage-list">{stages.map((stage, index) => { const approval = snapshot?.approvals.find((item) => item.stage === stage.id); const active = snapshot?.currentStage === stage.id; return <div className={`stage-row ${active ? 'active' : ''}`} key={stage.id}><span className="stage-number">0{index + 1}</span><div><strong>{stage.label}</strong><small>{approval ? approval.decision === 'approved' ? 'Aprovado pelo capitão' : 'Rejeitado para revisão' : active ? 'Proposta pronta para revisão' : 'Bloqueada pelo gate anterior'}</small></div><span className="stage-dot" />{active && <span className="active-mark">●</span>}</div>; })}</div><div className="actions">{snapshot?.status === 'needs_review' ? <><button className="secondary" onClick={() => review('reject')} disabled={busy}>Rejeitar proposta</button>{snapshot.currentStage === 'finalization' ? <span className="qa-chip">Aprovar é publicar o bundle no Gate 3 abaixo</span> : <button className="primary" onClick={() => review('approve')} disabled={busy}>Aprovar gate</button>}</> : <button className="primary" onClick={runStage} disabled={!snapshot || busy || snapshot.status === 'succeeded'}>{busy ? 'Executando…' : snapshot?.status === 'succeeded' ? 'Release publicado' : snapshot?.status === 'rejected' ? 'Refazer etapa' : 'Executar próxima etapa'}</button>}</div></section>
      <section className="review-panel"><div className="section-heading"><div><p className="eyebrow">Revisão visual</p><h2>Preview isolado</h2></div><span className="qa-chip">linter: {snapshot?.lintErrorCount ?? 0} erros</span></div>{snapshot ? <><div className="route-tabs">{snapshot.rendered.routes.map((item) => <button key={item.route} className={route === item.route ? 'selected' : ''} onClick={() => setRoute(item.route)}>{item.route}</button>)}</div><iframe title="Preview do site" src={previewUrl} sandbox="" className="preview-frame" /></> : <div className="empty-state"><span>△</span><p>Carregue o briefing para abrir o primeiro contrato de identidade.</p></div>}</section>
      <section className="chain-panel">
        <div className="section-heading"><div><p className="eyebrow">Finalização</p><h2>O que o Gate 3 compila</h2></div></div>
        {chainRunId
          ? <><p className="chain-line">{chainStale
              ? <>Cadeia identidade → protótipo <code>{chainRunId}</code>: a identidade mudou depois do Gate 1; aprove-a de novo antes de medir o protótipo e publicar.</>
              : <>Cadeia identidade → protótipo: Gate 1 <code>{chainRunId}</code> aprovou a versão <code>{identity!.handoff!.versionId}</code>{prototypeVersionId ? <> e o Gate 2 aprovou <code>{prototypeVersionId}</code>, que desce dela</> : <>, e o Gate 2 ainda não aprovou nenhuma revisão que desça dela</>}.</>}</p>
            <div className="actions">
              <button className="secondary" onClick={runChainStage} title={chainGate?.blocker} disabled={chainBusy || chainStale || !prototypeVersionId || chainRun?.currentStage === 'finalization'}>{chainBusy ? 'Executando…' : 'Executar a etapa de finalização'}</button>
              {!chainStale && !prototypeVersionId && <span className="qa-chip"><a href={GATE2_ROUTE}>Meça e aprove o protótipo no Gate 2</a></span>}
            </div></>
          : <p className="chain-line">Nenhuma identidade aprovada neste navegador: o Gate 3 abaixo compila o briefing fixo desta demonstração. Aprove uma identidade no Gate 1 para publicar a sua.</p>}
        {chainError && <p className="error-banner" role="alert">{chainError}</p>}
      </section>
      <Gate3Panel key={chainRunId || snapshot?.runId || 'none'} runId={chainRunId || snapshot?.runId || null} apiOrigin={API_ORIGIN} onPublished={(run) => (chainRunId ? setChainRun(run as Snapshot) : setSnapshot(run as Snapshot))} />
      {error && <p className="error-banner" role="alert">{error}</p>}
    </main>}
    <footer><span>DesignIR → Preview → Export</span><span>renderer determinístico · preview em origem separada</span></footer>
  </div>;
}
