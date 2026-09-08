import { useCallback, useEffect, useMemo, useState } from 'react';
import Gate2 from './Gate2.js';
import Gate3Panel from './Gate3Panel.js';
import IdentityGate, { type IdentityGateSnapshot } from './gate1/IdentityGate.js';
import { RequestError, requestJson } from './request.js';

interface Snapshot {
  runId: string;
  projectId: string;
  status: 'queued' | 'needs_review' | 'rejected' | 'cancelled' | 'succeeded' | 'failed';
  currentStage: 'identity' | 'prototype' | 'finalization' | null;
  currentVersion: { id: string; hash: string };
  rendered: { routes: Array<{ route: string; title: string; html: string }> };
  approvals: Array<{ stage: string; decision: string; versionId: string }>;
  exportManifest?: { digest: string; routes: Array<{ route: string; path: string }> };

  lintErrorCount: number;
}

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:4310';
const PREVIEW_ORIGIN = import.meta.env.VITE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:4311';
const stages = [{ id: 'identity', label: '01 Identidade' }, { id: 'prototype', label: '02 Protótipo' }, { id: 'finalization', label: '03 Finalização' }] as const;
const views = [{ id: 'pipeline', label: 'Pipeline' }, { id: 'gate1', label: 'Gate 1 · identidade' }] as const;
type ViewId = (typeof views)[number]['id'];

/**
 * The one identity run this browser last worked on. A Gate 1 the captain left
 * open outlives both the tab and the server process, so the screen reopens it
 * from the ledger instead of starting an expensive fan-out again.
 */
const IDENTITY_RUN_KEY = 'pwb.gate1.runId';
function rememberedIdentityRun(): string {
  try { return window.localStorage.getItem(IDENTITY_RUN_KEY) ?? ''; } catch { return ''; }
}
function rememberIdentityRun(runId: string): void {
  try { window.localStorage.setItem(IDENTITY_RUN_KEY, runId); } catch { /* a browser that refuses storage still decides the gate in this session */ }
}
function forgetIdentityRun(): void {
  try { window.localStorage.removeItem(IDENTITY_RUN_KEY); } catch { /* nothing to forget */ }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(`${API_ORIGIN}${path}`, init);
}

const GATE2_ROUTE = '#/gate-2';

/** A run the server answers 404 for is gone; anything else is worth trying again. */
function isGone(cause: unknown): boolean {
  return cause instanceof RequestError && cause.status === 404;
}

/** How many readings in a row may fail before the screen stops following the raster lane. */
const POLL_MAX_FAILURES = 10;

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [route, setRoute] = useState('/');
  const [view, setView] = useState<ViewId>('pipeline');
  const [identity, setIdentity] = useState<IdentityGateSnapshot | null>(null);
  const [identityError, setIdentityError] = useState('');
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

  const identityAct = useCallback(async (action: () => Promise<IdentityGateSnapshot>): Promise<void> => {
    setBusy(true); setIdentityError('');
    try { const next = await action(); rememberIdentityRun(next.runId); setIdentity(next); } catch (cause) { setIdentityError(cause instanceof Error ? cause.message : 'Erro desconhecido.'); } finally { setBusy(false); }
  }, []);
  const identityGet = useCallback((runId: string) => request<IdentityGateSnapshot>(`/api/identity/runs/${encodeURIComponent(runId)}`), []);
  const openIdentityRun = useCallback((runId: string) => { void identityAct(() => identityGet(runId)); }, [identityAct, identityGet]);

  useEffect(() => {
    const remembered = rememberedIdentityRun();
    if (!remembered) return;
    // Only a run the server no longer knows is forgotten. A server that is not
    // listening yet says nothing about whether the run exists, and the id is
    // the captain's one pointer back to a decided gate.
    void identityGet(remembered).then(setIdentity, (cause: unknown) => {
      if (isGone(cause)) { forgetIdentityRun(); return; }
      setIdentityError(cause instanceof Error ? cause.message : 'Erro desconhecido.');
    });
  }, [identityGet]);

  // Imagery is shot on the raster lane after the gate closes, so the decided
  // screen follows it until every asset has settled. A reading that failed is
  // retried, because the server may be restarting mid-shoot, but only so many
  // times: a run that is gone, or a server that never comes back, ends the loop
  // and says so rather than being polled in silence for the rest of the session.
  const [pollFailures, setPollFailures] = useState(0);
  const generating = identity?.assets.some((asset) => asset.status === 'generating') ?? false;
  useEffect(() => {
    if (!identity || !generating || pollFailures >= POLL_MAX_FAILURES) return;
    const runId = identity.runId;
    const timer = setTimeout(() => {
      void identityGet(runId).then(
        (next) => { setIdentity(next); setPollFailures(0); },
        (cause: unknown) => {
          if (isGone(cause)) {
            forgetIdentityRun();
            setPollFailures(POLL_MAX_FAILURES);
            setIdentityError('Esta execução não está mais no servidor.');
            return;
          }
          const failures = pollFailures + 1;
          setPollFailures(failures);
          if (failures >= POLL_MAX_FAILURES) setIdentityError('Não foi possível acompanhar a geração das imagens. Recarregue para ler o estado atual.');
        },
      );
    }, 1500);
    return () => { clearTimeout(timer); };
  }, [generating, identity, identityGet, pollFailures]);
  const identityPost = (path: string, payload: Record<string, unknown> = {}) => request<IdentityGateSnapshot>(path, { method: 'POST', body: JSON.stringify({ approverRole: 'captain', ...payload }) });
  const createIdentityRun = () => identityAct(() => identityPost('/api/identity/runs', { runId: `identity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }));
  const startIdentityRun = () => identity && identityAct(() => identityPost(`/api/identity/runs/${identity.runId}/start`));
  const approveDirection = (directionId: string, rationale: string, overrideRationale?: string) => identity && identityAct(() => identityPost(`/api/identity/runs/${identity.runId}/approve`, { directionId, rationale, ...(overrideRationale ? { overrideRationale } : {}) }));
  const rejectDirection = (directionId: string, rationale: string) => identity && identityAct(() => identityPost(`/api/identity/runs/${identity.runId}/reject`, { directionId, rationale }));
  const changeIdentityToken = (tokenPath: string, value: string) => identity && identityAct(() => identityPost(`/api/identity/runs/${identity.runId}/token`, { tokenPath, value, rationale: 'Mudança de token pedida pelo capitão depois do gate.' }));
  const runStage = () => snapshot && act(async () => request<Snapshot>(`/api/runs/${snapshot.runId}/stage`, { method: 'POST' }));
  const review = (decision: 'approve' | 'reject') => snapshot && act(async () => request<Snapshot>(`/api/runs/${snapshot.runId}/${decision}`, { method: 'POST', body: JSON.stringify({ approverRole: 'captain', stage: snapshot.currentStage, rationale: decision === 'approve' ? 'Gate aprovado pelo capitão.' : 'Revisar a proposta antes de continuar.' }) }));

  if (hash === GATE2_ROUTE || hash.startsWith(`${GATE2_ROUTE}/`)) return <Gate2 />;

  return <div className="studio-shell">
    <header className="topbar"><div><span className="eyebrow">FIRSTMATE / STUDIO LOCAL</span><h1>Compilador de identidade</h1></div><nav className="view-tabs" aria-label="Telas do estúdio">{views.map((item) => <button key={item.id} className={view === item.id ? 'selected' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}>{item.label}</button>)}</nav><span className="local-pill">uso próprio · pt-BR</span><a className="gate2-link" href={GATE2_ROUTE}>Gate 2 · revisão do protótipo →</a></header>
    {view === 'gate1' ? <main className="workspace workspace-single"><IdentityGate snapshot={identity} busy={busy} error={identityError} onCreate={createIdentityRun} onOpen={openIdentityRun} onStart={startIdentityRun} onApprove={approveDirection} onReject={rejectDirection} onChangeToken={changeIdentityToken} previewOrigin={PREVIEW_ORIGIN} /></main> : <main className="workspace">
      <section className="intro-panel"><p className="eyebrow">A identidade é o contrato</p><h2>Da direção visual ao site final, uma fonte de verdade.</h2><p>O editor mostra propostas tipadas; o renderer determinístico cuida do resultado. Os três gates desta versão são do capitão.</p><button className="primary" onClick={create} disabled={busy}>{busy ? 'Preparando…' : snapshot ? 'Reiniciar briefing' : 'Carregar briefing fixo'}</button></section>
      <section className="stage-panel"><div className="section-heading"><div><p className="eyebrow">Pipeline</p><h2>Três etapas, três decisões</h2></div>{snapshot && <span className={`status status-${snapshot.status}`}>{snapshot.status === 'needs_review' ? 'aguarda gate' : snapshot.status === 'rejected' ? 'rejeitado · reexecutar' : snapshot.status}</span>}</div><div className="stage-list">{stages.map((stage, index) => { const approval = snapshot?.approvals.find((item) => item.stage === stage.id); const active = snapshot?.currentStage === stage.id; return <div className={`stage-row ${active ? 'active' : ''}`} key={stage.id}><span className="stage-number">0{index + 1}</span><div><strong>{stage.label}</strong><small>{approval ? approval.decision === 'approved' ? 'Aprovado pelo capitão' : 'Rejeitado para revisão' : active ? 'Proposta pronta para revisão' : 'Bloqueada pelo gate anterior'}</small></div><span className="stage-dot" />{active && <span className="active-mark">●</span>}</div>; })}</div><div className="actions">{snapshot?.status === 'needs_review' ? <><button className="secondary" onClick={() => review('reject')} disabled={busy}>Rejeitar proposta</button>{snapshot.currentStage === 'finalization' ? <span className="qa-chip">Aprovar é publicar o bundle no Gate 3 abaixo</span> : <button className="primary" onClick={() => review('approve')} disabled={busy}>Aprovar gate</button>}</> : <button className="primary" onClick={runStage} disabled={!snapshot || busy || snapshot.status === 'succeeded'}>{busy ? 'Executando…' : snapshot?.status === 'succeeded' ? 'Release publicado' : snapshot?.status === 'rejected' ? 'Refazer etapa' : 'Executar próxima etapa'}</button>}</div></section>
      <section className="review-panel"><div className="section-heading"><div><p className="eyebrow">Revisão visual</p><h2>Preview isolado</h2></div><span className="qa-chip">linter: {snapshot?.lintErrorCount ?? 0} erros</span></div>{snapshot ? <><div className="route-tabs">{snapshot.rendered.routes.map((item) => <button key={item.route} className={route === item.route ? 'selected' : ''} onClick={() => setRoute(item.route)}>{item.route}</button>)}</div><iframe title="Preview do site" src={previewUrl} sandbox="" className="preview-frame" /></> : <div className="empty-state"><span>△</span><p>Carregue o briefing para abrir o primeiro contrato de identidade.</p></div>}</section>
      <Gate3Panel key={snapshot?.runId ?? 'none'} runId={snapshot?.runId ?? null} apiOrigin={API_ORIGIN} onPublished={(run) => setSnapshot(run as Snapshot)} />
      {error && <p className="error-banner" role="alert">{error}</p>}
    </main>}
    <footer><span>DesignIR → Preview → Export</span><span>renderer determinístico · preview em origem separada</span></footer>
  </div>;
}
