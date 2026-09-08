import type { QaCheck } from '@pwb/qa-deterministic';
import { ClaudeSession, ClaudeSessionError, CRITIC_DENIED_TOOLS, type ClaudeSessionOptions, type StructuredSession } from './claude-session.js';
import { CodexSessionError } from './codex-session.js';
import type { CritiqueTask } from './critics.js';
import { definitionFor, renderCritiquePrompt } from './critics.js';
import { critiqueReportSchema, critiqueSchemaJson, patchablePropSchema, type CritiqueReport, type EvidenceRef, type Finding } from './critique.js';

export interface CritiqueProvider {
  critique(task: CritiqueTask, signal?: AbortSignal): Promise<CritiqueReport>;
}

/** A critic that could not answer within its contract escalates; it never invents a verdict. */
export class CritiqueUnavailableError extends Error {
  constructor(public readonly taskId: string, public readonly errorCode: string, message: string) {
    super(message);
    this.name = 'CritiqueUnavailableError';
  }
}

function evidenceOf(task: CritiqueTask, check: QaCheck): EvidenceRef {
  const context = check.context ?? task.captures[0]?.context;
  if (!context) throw new Error(`Task ${task.id} carries neither a check context nor a capture to locate a finding.`);
  return { route: context.route, viewport: context.viewport, state: context.state, colorScheme: context.colorScheme, reducedMotion: context.reducedMotion, nodeIds: check.nodeIds.length > 0 ? check.nodeIds : ['document'] };
}

function copyFor(task: CritiqueTask, nodeId: string): string | undefined {
  for (const slice of task.routeSlices) for (const node of slice.nodes) {
    if (node.id === nodeId && typeof node.props.text === 'string') return node.props.text;
  }
  return undefined;
}

/**
 * The deterministic stand-in used by CI and the fixture journey. It reads the same Tier 1 evidence a
 * real critic reads and turns it into the same typed report, so the loop, the planner and the gate are
 * exercised end to end without a model. It never invents a problem the deterministic gate did not see.
 */
export class FakeCritiqueProvider implements CritiqueProvider {
  async critique(task: CritiqueTask, signal?: AbortSignal): Promise<CritiqueReport> {
    if (signal?.aborted) throw new DOMException('The critique was cancelled.', 'AbortError');
    const definition = definitionFor(task.dimension);
    // The same defect seen at several widths is one finding, exactly as a reader would report it.
    const seen = new Set<string>();
    const findings = task.qaChecks.flatMap((check, index) => {
      const key = `${check.id}:${check.nodeIds.join(',')}:${check.prop ?? ''}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return this.findingFor(task, check, index) ?? [];
    }).slice(0, 12);
    const worst = findings.some((finding) => finding.severity === 'blocker') ? 0
      : findings.some((finding) => finding.severity === 'major') ? 2
        : findings.length > 0 ? 3 : 4;
    const uncertain = findings.some((finding) => finding.abstain);
    return critiqueReportSchema.parse({
      schemaVersion: '1',
      stage: 'prototype',
      dimension: task.dimension,
      criticSessionId: task.criticSessionId,
      perception: {
        summary: `Leitura determinística de ${task.captures.length} captura(s) em ${task.routeSlices.map((slice) => slice.route).join(', ')}.`,
        regions: task.routeSlices.flatMap((slice) => slice.nodes.slice(0, 3).map((node) => ({ nodeId: node.id, role: node.semantic, note: `${node.kind} em ${slice.route}` }))),
      },
      comprehension: {
        hierarchy: `A rota inicial apresenta ${task.routeSlices[0]?.nodes.length ?? 0} nós na ordem declarada pelo arquiteto de informação.`,
        intent: definition.focus,
        brandAlignment: `Direção declarada: ${task.identity.direction.thesis}.`,
      },
      projection: {
        verdict: uncertain ? 'uncertain' : findings.some((finding) => finding.severity === 'major' || finding.severity === 'blocker') ? 'revise' : 'pass',
        rubric: definition.rubric.map((entry) => ({ criterion: entry.criterion, score: worst, evidence: `Derivado das checagens determinísticas de Tier 1 (${task.qaChecks.length} observações).` })),
        findings,
      },
    });
  }

  private findingFor(task: CritiqueTask, check: QaCheck, index: number): Finding | undefined {
    const nodeId = check.nodeIds[0];
    const id = `${task.dimension}-${check.id}-${index}`;
    const base = { id, dimension: task.dimension, evidence: evidenceOf(task, check), checks: [check.id], abstain: false };

    if (task.dimension === 'coherence' && check.id === 'QA1-RHYTHM' && nodeId) {
      const prop = patchablePropSchema.safeParse(check.prop ?? 'gap');
      if (!prop.success) return undefined;
      return {
        ...base, severity: 'major' as const, confidence: 0.8,
        observation: `O nó ${nodeId} usa ${prop.data} fora do ritmo declarado.`,
        why: 'A gramática de grid é parte do contrato aprovado; um espaçamento fora do ritmo lê como acidente.',
        patch: { operation: 'set_token' as const, nodeId, prop: prop.data, token: task.identity.gridGrammar.rhythmToken },
      };
    }
    if (task.dimension === 'responsiveness' && check.id === 'QA1-ALIGNMENT' && nodeId) {
      return {
        ...base, severity: 'minor' as const, confidence: 0.6,
        observation: `Os irmãos de ${nodeId} desalinham por menos de um gutter.`,
        why: 'Um desalinhamento sub-gutter é lido como erro de execução, não como intenção de composição.',
        patch: { operation: 'set_constraint' as const, nodeId, minWidth: task.identity.gridGrammar.breakpointTokens[0]!, prop: 'paddingInline' as const, token: task.identity.gridGrammar.gutterToken },
      };
    }
    if (task.dimension === 'narrative' && check.id === 'QA1-TRUNCATION' && nodeId) {
      const text = copyFor(task, nodeId);
      if (!text || text.length <= 24) return undefined;
      return {
        ...base, severity: 'minor' as const, confidence: 0.55,
        observation: `O nó ${nodeId} corta o texto na largura capturada.`,
        why: 'Uma frase cortada quebra a leitura de cinco segundos que a rota precisa entregar.',
        patch: { operation: 'replace_copy' as const, nodeId, text: `${text.slice(0, 24).trimEnd()}.` },
      };
    }
    if (task.dimension === 'a11y-interaction' && check.id === 'QA1-AXE') {
      return {
        ...base, severity: 'major' as const, abstain: true, confidence: 0.4,
        observation: check.message,
        why: 'Acessibilidade parcial não se decide por automação; a checagem moderada precisa de avaliação humana.',
      };
    }
    return undefined;
  }
}

/**
 * Runs one critic as its own local Claude Code session. The session is separate from the generator's,
 * carries no history of how the composition was made, and is allowed to read only the screenshots it
 * was handed. No credential is read, requested, logged or stored.
 */
export class ClaudeCritiqueRunner implements CritiqueProvider {
  private readonly session: StructuredSession;

  constructor(options: ClaudeSessionOptions & { session?: StructuredSession } = {}) {
    const { session, ...sessionOptions } = options;
    this.session = session ?? new ClaudeSession({ timeoutMs: 3 * 60_000, maxTurns: 3, deniedTools: CRITIC_DENIED_TOOLS, ...sessionOptions });
  }

  async critique(task: CritiqueTask, signal?: AbortSignal): Promise<CritiqueReport> {
    try {
      const report = await this.session.ask({
        sessionId: task.criticSessionId,
        prompt: renderCritiquePrompt(task),
        schema: critiqueSchemaJson.CritiqueReport,
        parse: (value) => critiqueReportSchema.parse(value),
        deadlineMs: task.deadlineMs,
        ...(signal ? { signal } : {}),
      });
      if (report.dimension !== task.dimension) throw new CritiqueUnavailableError(task.id, 'DIMENSION_MISMATCH', `The ${task.dimension} critic answered as ${report.dimension}.`);
      return report;
    } catch (error) {
      if (error instanceof CritiqueUnavailableError) throw error;
      if (error instanceof ClaudeSessionError) throw new CritiqueUnavailableError(task.id, error.errorCode, `The ${task.dimension} critic could not produce a typed report (${error.errorCode}).`);
      if (error instanceof CodexSessionError) throw new CritiqueUnavailableError(task.id, error.errorCode, `The ${task.dimension} critic could not produce a typed report (${error.errorCode}).`);
      throw error;
    }
  }
}
