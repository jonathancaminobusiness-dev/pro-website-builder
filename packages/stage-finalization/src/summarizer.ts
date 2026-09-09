import { releaseJsonSchemas, releaseSummarySchema, type ReleaseCritique, type ReleaseSummary, type ReleaseVeto } from '@pwb/domain';
import { runValidatedJson, type JsonModelRunner } from '@pwb/providers';
import { vetoDefinition } from './veto-catalog.js';

export interface ReleaseSummarizerInput {
  bundleDigest: string;
  vetoes: ReleaseVeto[];
  critiques: ReleaseCritique[];
  escalations: string[];
}

export interface ReleaseSummarizerProvider {
  summarize(input: ReleaseSummarizerInput, signal?: AbortSignal): Promise<ReleaseSummary>;
}

/**
 * Forces a summary to agree with the authoritative veto list.
 *
 * The summarizer has no gate authority, and this is where that is enforced
 * rather than asserted: whatever it returns, the count it reports is replaced by
 * the real one before anyone reads it, and `evaluateReleaseGate` never consults
 * the summary at all.
 */
export function sealSummary(summary: ReleaseSummary, vetoes: ReleaseVeto[]): ReleaseSummary {
  const named = vetoes.map((veto) => `${vetoDefinition(veto.id).title} — ${veto.where}`);
  const openQuestions = [...new Set([...summary.openQuestions, ...named])];
  return releaseSummarySchema.parse({ ...summary, vetoCount: vetoes.length, gateAuthority: 'none', openQuestions });
}

export class DeterministicReleaseSummarizer implements ReleaseSummarizerProvider {
  async summarize(input: ReleaseSummarizerInput, signal?: AbortSignal): Promise<ReleaseSummary> {
    if (signal?.aborted) throw new DOMException('The summarizer session was cancelled.', 'AbortError');
    const scores = input.critiques.map((critique) => `${critique.dimension}: ${critique.rubricScore}/4 (${critique.verdict})`);
    return sealSummary(releaseSummarySchema.parse({
      headline: input.vetoes.length > 0
        ? `Release ${input.bundleDigest.slice(0, 12)} bloqueado por ${input.vetoes.length} veto(s).`
        : `Release ${input.bundleDigest.slice(0, 12)} sem veto; a decisão é do capitão.`,
      highlights: scores,
      openQuestions: input.escalations,
      vetoCount: input.vetoes.length,
      gateAuthority: 'none',
    }), input.vetoes);
  }
}

export class ClaudeReleaseSummarizer implements ReleaseSummarizerProvider {
  constructor(private readonly runner: JsonModelRunner, private readonly deadlineMs = 4 * 60_000) {}

  async summarize(input: ReleaseSummarizerInput, signal?: AbortSignal): Promise<ReleaseSummary> {
    const prompt = [
      'You are the release-summarizer. You explain a finished release to the captain in pt-BR.',
      'You have no gate authority: you never approve, never reject, never soften a veto and never omit one. The gate recomputes every veto from the raw artifacts regardless of what you write.',
      `This is what the release produced: ${JSON.stringify(input)}`,
    ].join('\n');
    const parsed = await runValidatedJson(this.runner, { prompt, schema: releaseJsonSchemas.ReleaseSummary, deadlineMs: this.deadlineMs }, (raw) => releaseSummarySchema.parse(raw), signal);
    return sealSummary(parsed, input.vetoes);
  }
}
