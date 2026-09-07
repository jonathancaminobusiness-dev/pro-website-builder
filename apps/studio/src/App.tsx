import { useEffect, useMemo, useState } from 'react';
import Gate2 from './Gate2.js';
import Gate3Panel from './Gate3Panel.js';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'Não foi possível concluir a ação.');
  return payload;
}

const GATE2_ROUTE = '#/gate-2';

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [route, setRoute] = useState('/');
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
  const runStage = () => snapshot && act(async () => request<Snapshot>(`/api/runs/${snapshot.runId}/stage`, { method: 'POST' }));
  const review = (decision: 'approve' | 'reject') => snapshot && act(async () => request<Snapshot>(`/api/runs/${snapshot.runId}/${decision}`, { method: 'POST', body: JSON.stringify({ approverRole: 'captain', stage: snapshot.currentStage, rationale: decision === 'approve' ? 'Gate aprovado pelo capitão.' : 'Revisar a proposta antes de continuar.' }) }));

  if (hash === GATE2_ROUTE || hash.startsWith(`${GATE2_ROUTE}/`)) return <Gate2 />;

  return <div className="studio-shell">
    <header className="topbar"><div><span className="eyebrow">FIRSTMATE / STUDIO LOCAL</span><h1>Compilador de identidade</h1></div><span className="local-pill">uso próprio · pt-BR</span><a className="gate2-link" href={GATE2_ROUTE}>Gate 2 · revisão do protótipo →</a></header>
    <main className="workspace">
      <section className="intro-panel"><p className="eyebrow">A identidade é o contrato</p><h2>Da direção visual ao site final, uma fonte de verdade.</h2><p>O editor mostra propostas tipadas; o renderer determinístico cuida do resultado. Os três gates desta versão são do capitão.</p><button className="primary" onClick={create} disabled={busy}>{busy ? 'Preparando…' : snapshot ? 'Reiniciar briefing' : 'Carregar briefing fixo'}</button></section>
      <section className="stage-panel"><div className="section-heading"><div><p className="eyebrow">Pipeline</p><h2>Três etapas, três decisões</h2></div>{snapshot && <span className={`status status-${snapshot.status}`}>{snapshot.status === 'needs_review' ? 'aguarda gate' : snapshot.status === 'rejected' ? 'rejeitado · reexecutar' : snapshot.status}</span>}</div><div className="stage-list">{stages.map((stage, index) => { const approval = snapshot?.approvals.find((item) => item.stage === stage.id); const active = snapshot?.currentStage === stage.id; return <div className={`stage-row ${active ? 'active' : ''}`} key={stage.id}><span className="stage-number">0{index + 1}</span><div><strong>{stage.label}</strong><small>{approval ? approval.decision === 'approved' ? 'Aprovado pelo capitão' : 'Rejeitado para revisão' : active ? 'Proposta pronta para revisão' : 'Bloqueada pelo gate anterior'}</small></div><span className="stage-dot" />{active && <span className="active-mark">●</span>}</div>; })}</div><div className="actions">{snapshot?.status === 'needs_review' ? <><button className="secondary" onClick={() => review('reject')} disabled={busy}>Rejeitar proposta</button>{snapshot.currentStage === 'finalization' ? <span className="qa-chip">Aprovar é publicar o bundle no Gate 3 abaixo</span> : <button className="primary" onClick={() => review('approve')} disabled={busy}>Aprovar gate</button>}</> : <button className="primary" onClick={runStage} disabled={!snapshot || busy || snapshot.status === 'succeeded'}>{busy ? 'Executando…' : snapshot?.status === 'succeeded' ? 'Release publicado' : snapshot?.status === 'rejected' ? 'Refazer etapa' : 'Executar próxima etapa'}</button>}</div></section>
      <section className="review-panel"><div className="section-heading"><div><p className="eyebrow">Revisão visual</p><h2>Preview isolado</h2></div><span className="qa-chip">linter: {snapshot?.lintErrorCount ?? 0} erros</span></div>{snapshot ? <><div className="route-tabs">{snapshot.rendered.routes.map((item) => <button key={item.route} className={route === item.route ? 'selected' : ''} onClick={() => setRoute(item.route)}>{item.route}</button>)}</div><iframe title="Preview do site" src={previewUrl} sandbox="" className="preview-frame" /></> : <div className="empty-state"><span>△</span><p>Carregue o briefing para abrir o primeiro contrato de identidade.</p></div>}</section>
      <Gate3Panel runId={snapshot?.runId ?? null} apiOrigin={API_ORIGIN} />
      {error && <p className="error-banner" role="alert">{error}</p>}
    </main>
    <footer><span>DesignIR → Preview → Export</span><span>renderer determinístico · preview em origem separada</span></footer>
  </div>;
}
