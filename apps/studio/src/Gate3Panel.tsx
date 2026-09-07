import { useCallback, useState } from 'react';
import './gate3.css';

interface Veto { id: string; detector: string; where: string; detail: string }
interface RubricRow { dimension: string; score: number; verdict: string }
interface EvidenceRow { id: string; runner: string; engine: string; route: string; state: string; status: string }
interface ReleaseSnapshot {
  digest: string;
  versionId: string;
  refinedFromVersionId: string;
  report: {
    blocked: boolean; bundleDigest: string; irHash: string; rendererVersion: string; compilerVersion: string;
    approvedVersionId: string; releasedVersionId: string;
    vetoes: Veto[]; rubric: RubricRow[]; escalations: string[]; refinementCycles: number;
    parity: { matched: boolean; routes: Array<{ route: string; matched: boolean; differences: string[] }> };
    evidence: EvidenceRow[];
    summary?: { headline: string; highlights: string[]; openQuestions: string[]; vetoCount: number; gateAuthority: string };
  };
  catalog: Array<{ id: string; title: string; clears: string }>;
  published?: { directory: string; digest: string };
}

const RUBRIC_MINIMUM = 3;
const DIMENSIONS: Record<string, string> = {
  accessibility: 'Acessibilidade',
  'semantics-seo': 'Semântica e SEO',
  'visual-regression': 'Regressão visual e responsividade',
  'asset-performance': 'Performance de assets',
  'provenance-security': 'Proveniência, licença e segurança',
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'Não foi possível concluir a ação.');
  return payload;
}

/**
 * Gate 3. It shows the release exactly as the report describes it: the vetoes
 * that block it, the rubric each critic gave, the parity with the preview, and
 * which independent runners produced evidence. The summary is displayed with
 * its lack of authority stated, and publishing sends the digest the captain is
 * looking at, so a release that moved cannot be published by mistake.
 *
 * A gap the gate could not decide — a missing engine, an unresolved placeholder
 * — does not block, but publishing over it takes a written reason, kept in the
 * run's log and in the release record beside the bundle.
 */
export default function Gate3Panel({ runId, apiOrigin }: { runId: string | null; apiOrigin: string }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ReleaseSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rationale, setRationale] = useState('');

  const act = useCallback(async (action: () => Promise<ReleaseSnapshot>) => {
    setBusy(true); setError('');
    try { setSnapshot(await action()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Erro desconhecido.'); }
    finally { setBusy(false); }
  }, []);

  const prepare = (): void => { if (runId) void act(() => request<ReleaseSnapshot>(`${apiOrigin}/api/runs/${runId}/release`, { method: 'POST' })); };
  const publish = (): void => {
    if (!runId || !snapshot) return;
    void act(async () => (await request<{ snapshot: ReleaseSnapshot }>(`${apiOrigin}/api/runs/${runId}/release/publish`, { method: 'POST', body: JSON.stringify({ approverRole: 'captain', digest: snapshot.digest, rationale }) })).snapshot);
  };

  const report = snapshot?.report;
  const titles = new Map((snapshot?.catalog ?? []).map((entry) => [entry.id, entry.title]));
  const engines = [...new Set((report?.evidence ?? []).map((row) => row.engine))].sort();
  const runners = [...new Set((report?.evidence ?? []).map((row) => row.runner))].sort();

  return <section className="gate3-panel">
    <div className="section-heading">
      <div><p className="eyebrow">Gate 3 · release imutável</p><h2>Bundle content-addressed e evidência independente</h2></div>
      {report && <span className={`verdict ${report.blocked ? 'blocked' : ''}`}>{report.blocked ? `bloqueado · ${report.vetoes.length} veto(s)` : 'sem veto · decisão do capitão'}</span>}
    </div>

    {!report && <p className="empty-state"><span>▣</span>{runId ? 'Prepare o release para compilar o bundle, ouvir os cinco críticos e ler a evidência.' : 'Carregue o briefing para habilitar o gate de release.'}</p>}

    {report && <>
      <div className="gate3-grid">
        <div className="gate3-card">
          <h3>Bundle</h3>
          <dl className="gate3-facts">
            <div><dt>digest</dt><dd>{report.bundleDigest.slice(0, 24)}…</dd></div>
            <div><dt>documento</dt><dd>{report.irHash.slice(0, 16)}…</dd></div>
            <div><dt>versão aprovada</dt><dd>{report.approvedVersionId}</dd></div>
            {report.releasedVersionId !== report.approvedVersionId && <div><dt>versão do release</dt><dd>{report.releasedVersionId}</dd></div>}
            <div><dt>renderer</dt><dd>{report.rendererVersion}</dd></div>
            <div><dt>compilador</dt><dd>{report.compilerVersion}</dd></div>
            <div><dt>ciclos de refino</dt><dd>{report.refinementCycles} / 2</dd></div>
          </dl>
        </div>

        <div className="gate3-card">
          <h3>Vetos</h3>
          {report.vetoes.length === 0
            ? <p className="empty">Nenhum veto. Isso não é uma aprovação: publicar continua sendo decisão do capitão.</p>
            : report.vetoes.map((veto) => <div className="veto-item" key={`${veto.id}-${veto.where}`}>
                <strong>{titles.get(veto.id) ?? veto.id}</strong>
                <span>{veto.where} · {veto.detail}</span>
              </div>)}
        </div>

        <div className="gate3-card">
          <h3>Rubrica dos cinco críticos</h3>
          {report.rubric.length === 0
            ? <p className="empty">Nenhum parecer chegou.</p>
            : report.rubric.map((row) => <div className="rubric-row" key={row.dimension}>
                <span>{DIMENSIONS[row.dimension] ?? row.dimension}</span>
                <span className={`rubric-score ${row.score < RUBRIC_MINIMUM ? 'below' : ''}`}>{row.score}/4 · {row.verdict}</span>
              </div>)}
        </div>

        <div className="gate3-card">
          <h3>Paridade preview / release</h3>
          {report.parity.routes.map((route) => <div className="rubric-row" key={route.route}>
            <span>{route.route}</span>
            <span className={`rubric-score ${route.matched ? '' : 'below'}`}>{route.matched ? 'idêntico' : `${route.differences.length} diferença(s)`}</span>
          </div>)}
        </div>

        <div className="gate3-card">
          <h3>Evidência independente</h3>
          <dl className="gate3-facts">
            <div><dt>artefatos</dt><dd>{report.evidence.length}</dd></div>
            <div><dt>runners</dt><dd>{runners.join(', ') || '—'}</dd></div>
            <div><dt>engines</dt><dd>{engines.join(', ') || '—'}</dd></div>
          </dl>
        </div>

        <div className="gate3-card">
          <h3>Sobe para o capitão</h3>
          {report.escalations.length === 0
            ? <p className="empty">Nada em aberto além da própria decisão.</p>
            : <><ul>{report.escalations.map((line) => <li key={line}>{line}</li>)}</ul>
                <label className="acceptance">
                  <span>Aceitação do capitão, gravada no histórico da execução e no registro do release</span>
                  <textarea value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Por que estes pontos podem ser aceitos neste release?" rows={3} />
                </label></>}
        </div>
      </div>

      {report.summary && <p className="gate3-summary">
        {report.summary.headline}
        <em>Resumo do release-summarizer, sem autoridade de gate: os vetos acima são recalculados dos artefatos brutos.</em>
      </p>}
    </>}

    <div className="actions">
      <button className="secondary" onClick={prepare} disabled={!runId || busy}>{busy ? 'Executando…' : report ? 'Recompilar e reavaliar' : 'Preparar release'}</button>
      <button className="primary" onClick={publish} disabled={!report || report.blocked || busy || snapshot?.published !== undefined || (report.escalations.length > 0 && rationale.trim() === '')}>
        {snapshot?.published ? 'Bundle publicado' : 'Publicar bundle (capitão)'}
      </button>
    </div>
    {snapshot?.published && <p className="gate3-summary">Bundle imutável escrito em <code>{snapshot.published.directory}</code>.</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
  </section>;
}
