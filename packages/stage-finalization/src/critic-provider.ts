import { releaseCritiqueSchema, schemaJson, type AgentTask, type EvidenceArtifact, type ReleaseCritique, type ReleaseFinding } from '@pwb/domain';
import type { JsonModelRunner } from '@pwb/providers';
import type { CriticDefinition } from './critics.js';

export interface ReleaseCriticProvider {
  critique(task: AgentTask, definition: CriticDefinition, signal?: AbortSignal): Promise<ReleaseCritique>;
}

function slicePart<T>(task: AgentTask, key: string): T | undefined {
  return task.documentSlice[key] as T | undefined;
}

function score(findings: ReleaseFinding[]): { rubricScore: number; verdict: ReleaseCritique['verdict'] } {
  if (findings.some((finding) => finding.severity === 'error')) return { rubricScore: 2, verdict: 'revise' };
  if (findings.some((finding) => finding.severity === 'uncertain')) return { rubricScore: 3, verdict: 'uncertain' };
  if (findings.some((finding) => finding.severity === 'warning')) return { rubricScore: 3, verdict: 'pass' };
  return { rubricScore: 4, verdict: 'pass' };
}

interface ReleaseSlice {
  routes: Array<{ route: string; title: string; description: string; canonical: string; path: string }>;
  files: Array<{ path: string; hash: string; bytes: number }>;
  licenses: Array<{ id: string; license: string; bundled: boolean }>;
  csp: string;
  vetoes: Array<{ id: string; where: string; detail: string }>;
}

/** Route-level budgets the deterministic critic measures against. */
const HTML_BUDGET_BYTES = 150 * 1024;
const STYLESHEET_BUDGET_BYTES = 100 * 1024;
const DESCRIPTION_LIMIT = 160;

/**
 * A deterministic stand-in for the five release critics.
 *
 * It reads exactly the slice a real critic reads and produces the same shape of
 * report, so the whole finalization journey — fan-out, refinement, gate — runs
 * in CI without spending a model call. It is not a quality judgement: it only
 * restates what the evidence already shows.
 */
export class FakeReleaseCriticProvider implements ReleaseCriticProvider {
  async critique(task: AgentTask, definition: CriticDefinition, signal?: AbortSignal): Promise<ReleaseCritique> {
    if (signal?.aborted) throw new DOMException('The critic session was cancelled.', 'AbortError');
    const release = slicePart<ReleaseSlice>(task, '/release');
    const evidence = slicePart<EvidenceArtifact[]>(task, '/evidence') ?? [];
    const findings = release ? this.findings(definition, release, evidence) : [];
    const summaries: Record<CriticDefinition['dimension'], string> = {
      accessibility: 'Leitura determinística das varreduras axe e dos estados capturados.',
      'semantics-seo': 'Leitura determinística da estrutura semântica e dos metadados por rota.',
      'visual-regression': 'Leitura determinística das capturas de largura e engine.',
      'asset-performance': 'Leitura determinística do peso de cada rota e da folha de estilo.',
      'provenance-security': 'Leitura determinística do inventário de licenças e da política entregue.',
    };
    return releaseCritiqueSchema.parse({
      taskId: task.id,
      dimension: definition.dimension,
      summary: summaries[definition.dimension],
      findings,
      ...score(findings),
    });
  }

  private findings(definition: CriticDefinition, release: ReleaseSlice, evidence: EvidenceArtifact[]): ReleaseFinding[] {
    const findings: ReleaseFinding[] = [];
    const push = (finding: ReleaseFinding): void => { findings.push(finding); };

    if (definition.dimension === 'accessibility' || definition.dimension === 'visual-regression') {
      for (const artifact of evidence) {
        if (artifact.status === 'passed' && artifact.vetoes.length === 0) continue;
        const severity: ReleaseFinding['severity'] = artifact.vetoes.length > 0 || artifact.status === 'failed' ? 'error' : 'warning';
        push({
          id: `${definition.dimension}:${artifact.id}`,
          severity,
          route: artifact.route,
          evidenceRef: artifact.id,
          cause: artifact.vetoes[0]?.detail ?? artifact.notes[0] ?? `O artefato ${artifact.id} do runner ${artifact.runner} falhou em ${artifact.engine}.`,
          suggestion: { kind: definition.dimension === 'accessibility' ? 'token' : 'constraint', path: '/pages', note: 'Corrigir a causa apontada pela evidência antes de reabrir o gate.' },
        });
      }
    }

    if (definition.dimension === 'semantics-seo') {
      for (const route of release.routes) {
        if (route.description.trim() === '') push({ id: `seo:description:${route.route}`, severity: 'error', route: route.route, evidenceRef: `compiler:${route.path}`, cause: `A rota ${route.route} foi compilada sem descrição.`, suggestion: { kind: 'metadata', path: '/pages', note: 'Dar à rota um texto de corpo que sirva de descrição.' } });
        else if (route.description.length > DESCRIPTION_LIMIT) push({ id: `seo:description-length:${route.route}`, severity: 'warning', route: route.route, evidenceRef: `compiler:${route.path}`, cause: `A descrição da rota ${route.route} tem ${route.description.length} caracteres.`, suggestion: { kind: 'copy', path: '/pages', note: 'Encurtar o primeiro parágrafo da rota.' } });
        if (route.title.trim() === '') push({ id: `seo:title:${route.route}`, severity: 'error', route: route.route, evidenceRef: `compiler:${route.path}`, cause: `A rota ${route.route} foi compilada sem título.`, suggestion: { kind: 'metadata', path: '/pages', note: 'Dar um título à rota.' } });
      }
    }

    if (definition.dimension === 'asset-performance') {
      for (const file of release.files) {
        const budget = file.path.endsWith('.css') ? STYLESHEET_BUDGET_BYTES : file.path.endsWith('.html') ? HTML_BUDGET_BYTES : Number.POSITIVE_INFINITY;
        if (file.bytes > budget) push({ id: `perf:${file.path}`, severity: 'warning', route: file.path, evidenceRef: `compiler:${file.path}`, cause: `${file.path} pesa ${file.bytes} bytes, acima do orçamento de ${budget}.`, suggestion: { kind: 'constraint', path: '/pages', note: 'Reduzir o conteúdo da rota ou dividir a folha de estilo.' } });
      }
      const lighthouse = evidence.filter((artifact) => artifact.runner === 'lighthouse');
      if (lighthouse.length === 0) push({ id: 'perf:no-lighthouse', severity: 'uncertain', route: '/', evidenceRef: 'lighthouse:absent', cause: 'Nenhum artefato Lighthouse acompanha este release, então o custo real de carregamento não foi medido.', suggestion: { kind: 'constraint', path: '/pages', note: 'Executar o runner Lighthouse antes do gate ou registrar a exceção.' } });
    }

    if (definition.dimension === 'provenance-security') {
      for (const entry of release.licenses) {
        if (entry.bundled && entry.license.trim() === '') push({ id: `license:${entry.id}`, severity: 'error', route: '/', evidenceRef: `compiler:licenses.json`, cause: `${entry.id} está embarcado sem licença.`, suggestion: { kind: 'metadata', path: '/assets', note: 'Registrar a origem e a licença do asset.' } });
      }
      if (!release.csp.includes("script-src 'none'")) push({ id: 'security:script-src', severity: 'error', route: '/', evidenceRef: 'compiler:headers.json', cause: 'A política entregue não proíbe script.', suggestion: { kind: 'constraint', path: '/pages', note: 'Recompilar o release sem script.' } });
    }

    return findings;
  }
}

/**
 * The real critic: one Claude Code session per dimension, separate from the
 * session that produced the document, answering with schema-closed JSON.
 * `taskId` and `dimension` are re-stamped from the task so a session cannot
 * report under another critic's name.
 */
export class ClaudeReleaseCriticProvider implements ReleaseCriticProvider {
  constructor(private readonly runner: JsonModelRunner) {}

  async critique(task: AgentTask, definition: CriticDefinition, signal?: AbortSignal): Promise<ReleaseCritique> {
    const prompt = [
      `You are the ${definition.dimension} release critic for taskId ${task.id}.`,
      'You review a finished release. You never edit the document, never propose HTML and never approve anything: the captain decides at the gate.',
      definition.rubric,
      'Score the release from 0 to 4 on this dimension. The minimum the project accepts is 3.',
      'Every finding must name the evidence artifact it comes from, the cause, and one minimal suggestion. Answer "uncertain" instead of inventing precision the evidence does not support.',
      `This is the immutable slice you may read: ${JSON.stringify(task.documentSlice)}`,
    ].join('\n');
    const raw = await this.runner.run({ prompt, schema: schemaJson.ReleaseCritique, deadlineMs: task.deadlineMs }, signal);
    const parsed = releaseCritiqueSchema.parse(raw);
    return { ...parsed, taskId: task.id, dimension: definition.dimension };
  }
}
