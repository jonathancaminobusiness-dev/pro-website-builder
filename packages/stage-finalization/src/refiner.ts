import { patchSchema, schemaJson, type AgentTask, type DesignIR, type Patch, type ReleaseFinding } from '@pwb/domain';
import type { JsonModelRunner } from '@pwb/providers';

export interface ReleaseRefinerProvider {
  refine(task: AgentTask, findings: ReleaseFinding[], signal?: AbortSignal): Promise<Patch | undefined>;
}

export type RefinementDecision =
  | { action: 'stop'; reason: string; escalations: string[] }
  | { action: 'refine'; findingIds: string[] };

/**
 * The refinement loop, with the stop conditions the plan fixes.
 *
 * At most two cycles. A finding that survives a cycle unchanged is not tried a
 * third time: the same problem twice means the loop is not converging, and the
 * honest output is an escalation to the captain rather than another patch.
 */
export class PatchRefiner {
  readonly maxCycles = 2;

  constructor(private readonly provider: ReleaseRefinerProvider) {}

  decide(cycle: number, findings: ReleaseFinding[], previousFindingIds: string[]): RefinementDecision {
    const errors = findings.filter((finding) => finding.severity === 'error');
    const uncertain = findings.filter((finding) => finding.severity === 'uncertain');
    if (errors.length === 0) {
      return { action: 'stop', reason: 'Nenhum achado de erro restou nos críticos.', escalations: uncertain.map((finding) => `Crítico respondeu incerto em ${finding.route}: ${finding.cause}`) };
    }
    if (cycle >= this.maxCycles) {
      return { action: 'stop', reason: `O refino parou no limite de ${this.maxCycles} ciclos.`, escalations: errors.map((finding) => `Achado ainda aberto após ${this.maxCycles} ciclos em ${finding.route}: ${finding.cause}`) };
    }
    const ids = errors.map((finding) => finding.id).sort();
    const repeated = ids.filter((id) => previousFindingIds.includes(id));
    if (repeated.length === ids.length && ids.length > 0 && previousFindingIds.length > 0) {
      return { action: 'stop', reason: 'Os mesmos achados voltaram em duas rodadas.', escalations: repeated.map((id) => `Achado ${id} repetiu em duas rodadas; a decisão é humana.`) };
    }
    return { action: 'refine', findingIds: ids };
  }

  propose(task: AgentTask, findings: ReleaseFinding[], signal?: AbortSignal): Promise<Patch | undefined> {
    return this.provider.refine(task, findings, signal);
  }
}

/**
 * A deterministic refiner for CI.
 *
 * It makes the one repair a machine can make without a design decision: it
 * records the open findings in the document's review record, so the version the
 * captain sees carries the release review that produced it. Anything that needs
 * a judgement stays open and escalates.
 */
export class FakeReleaseRefiner implements ReleaseRefinerProvider {
  async refine(task: AgentTask, findings: ReleaseFinding[], signal?: AbortSignal): Promise<Patch | undefined> {
    if (signal?.aborted) throw new DOMException('The refiner session was cancelled.', 'AbortError');
    if (findings.length === 0) return undefined;
    const existing = (task.documentSlice['/reviewRecord'] as DesignIR['reviewRecord'] | undefined)?.findings ?? [];
    const lines = findings.map((finding) => `${finding.id}: ${finding.cause}`);
    return patchSchema.parse({
      operations: [{ op: 'replace', path: '/reviewRecord/findings', value: [...new Set([...existing, ...lines])].sort() }],
      baseVersionId: task.baseVersionId,
      touchedPaths: ['/reviewRecord/findings'],
      rationale: `O patch-refiner registra ${findings.length} achado(s) de release no histórico de revisão do documento.`,
      confidence: 1,
      stage: 'finalization',
      role: 'patch-refiner',
      idempotencyKey: task.inputDigest,
    });
  }
}

/** The real refiner: one session, schema-closed, restricted to the task's allowed paths. */
export class ClaudeReleaseRefiner implements ReleaseRefinerProvider {
  constructor(private readonly runner: JsonModelRunner) {}

  async refine(task: AgentTask, findings: ReleaseFinding[], signal?: AbortSignal): Promise<Patch | undefined> {
    const prompt = [
      `You are the patch-refiner of the finalization stage for taskId ${task.id}.`,
      'You return the smallest JSON patch that resolves the findings below. You never return HTML, never restructure the site and never touch a path outside the allowed list.',
      `The patch must set baseVersionId to ${task.baseVersionId} and may only touch: ${task.allowedPaths.join(', ')}.`,
      `Findings: ${JSON.stringify(findings)}`,
      `This is the immutable slice you may read: ${JSON.stringify(task.documentSlice)}`,
    ].join('\n');
    const raw = await this.runner.run({ prompt, schema: schemaJson.Patch, deadlineMs: task.deadlineMs }, signal);
    const parsed = patchSchema.parse(raw);
    return { ...parsed, baseVersionId: task.baseVersionId, stage: 'finalization', role: 'patch-refiner', idempotencyKey: task.inputDigest };
  }
}
