import { hashJson, type AgentTask, type DesignIR, type EvidenceArtifact, type ReleaseCriticDimension } from '@pwb/domain';
import type { CompiledSite } from '@pwb/export';

/** The rubric each critic scores against, on the plan's absolute 0–4 scale. */
export interface CriticDefinition {
  dimension: ReleaseCriticDimension;
  taskId: string;
  /** Which evidence runners this critic is allowed to reason from. */
  reads: EvidenceArtifact['runner'][];
  rubric: string;
  deadlineMs: number;
}

const THREE_MINUTES = 3 * 60_000;

/**
 * Five critics, five separate read-only sessions.
 *
 * They never share a session with the generator and never share one with each
 * other, so an agreement between two of them is evidence rather than an echo.
 * None of them may write: `allowedPaths` is empty for every critic task, so the
 * PatchGate would refuse any path a critic tried to touch.
 */
export const RELEASE_CRITICS: CriticDefinition[] = [
  {
    dimension: 'accessibility',
    taskId: 'release-critic-accessibility',
    reads: ['axe', 'playwright'],
    rubric: 'Score the release on keyboard reachability, focus visibility, accessible names, heading order, contrast and behaviour at 200% zoom. Ground every finding in an axe or Playwright artifact. Answer uncertain rather than inventing a judgement a scan cannot support.',
    deadlineMs: THREE_MINUTES,
  },
  {
    dimension: 'semantics-seo',
    taskId: 'release-critic-semantics-seo',
    reads: ['compiler', 'lighthouse'],
    rubric: 'Score the semantic structure and the per-route metadata: element choice, heading hierarchy, title and description usefulness, canonical URLs, Open Graph completeness and sitemap agreement. Structured data counts only when it is complete and true.',
    deadlineMs: THREE_MINUTES,
  },
  {
    dimension: 'visual-regression',
    taskId: 'release-critic-visual-regression',
    reads: ['playwright'],
    rubric: 'Score responsiveness and visual regression across the captured widths and engines: overflow, clipping, hidden calls to action, reduced-motion behaviour and parity between the preview and the release.',
    deadlineMs: THREE_MINUTES,
  },
  {
    dimension: 'asset-performance',
    taskId: 'release-critic-asset-performance',
    reads: ['lighthouse', 'compiler'],
    rubric: 'Score asset weight and delivery: bundle size per route, stylesheet size, font strategy and display, image dimensions and priority. Judge against the Core Web Vitals thresholds, and say plainly that a laboratory run is not field data.',
    deadlineMs: THREE_MINUTES,
  },
  {
    dimension: 'provenance-security',
    taskId: 'release-critic-provenance-security',
    reads: ['compiler', 'vitest'],
    rubric: 'Score provenance, licensing and the delivered security posture: every asset and face traced to a source and terms, the policy matching what the bundle contains, and no credential anywhere in the output.',
    deadlineMs: THREE_MINUTES,
  },
];

export interface CriticTaskContext {
  runId: string;
  baseVersionId: string;
  ir: DesignIR;
  compiled: CompiledSite;
  evidence: EvidenceArtifact[];
  attempt: number;
  promptVersion: string;
  modelAlias: string;
}

/**
 * Builds the immutable slice a critic reads. The slice carries the contract, the
 * page graph, the compiled release and the evidence the critic is allowed to
 * reason from — never the document object the Applier writes to.
 */
export function criticSlice(definition: CriticDefinition, context: CriticTaskContext): Record<string, unknown> {
  const readable = context.evidence.filter((artifact) => definition.reads.includes(artifact.runner));
  return {
    '/identity': context.ir.identity,
    '/pages': context.ir.pages,
    '/assets': context.ir.assets,
    '/release': {
      digest: context.compiled.digest,
      irHash: context.compiled.irHash,
      rendererVersion: context.compiled.rendererVersion,
      compilerVersion: context.compiled.compilerVersion,
      csp: context.compiled.csp,
      routes: context.compiled.routes,
      files: context.compiled.files.map((file) => ({ path: file.path, hash: file.hash, bytes: file.bytes })),
      fonts: context.compiled.fonts,
      licenses: context.compiled.licenses.entries,
      vetoes: context.compiled.vetoes,
    },
    '/evidence': readable,
    '/rubric': { dimension: definition.dimension, scale: '0-4', minimum: 3, text: definition.rubric },
  };
}

export function criticTasks(context: CriticTaskContext): Array<{ definition: CriticDefinition; task: AgentTask }> {
  return RELEASE_CRITICS.map((definition) => {
    const documentSlice = criticSlice(definition, context);
    return {
      definition,
      task: {
        id: `${definition.taskId}#${context.runId}`,
        attempt: context.attempt,
        stage: 'finalization',
        role: 'release-critic',
        state: 'queued',
        lane: 'claude',
        baseVersionId: context.baseVersionId,
        inputDigest: hashJson({ runId: context.runId, dimension: definition.dimension, documentSlice }),
        promptVersion: context.promptVersion,
        modelAlias: context.modelAlias,
        deadlineMs: definition.deadlineMs,
        // A critic observes and never edits: no path is writable to it.
        allowedPaths: [],
        brief: definition.rubric,
        documentSlice,
      },
    };
  });
}
