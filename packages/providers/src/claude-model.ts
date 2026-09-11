/**
 * Which model the product's Claude workers run on, and how hard they think.
 *
 * Left unset, `claude` runs on whatever the machine's Claude Code default
 * happens to be, so two checkouts of this repo could answer the same task with
 * different models. Every Claude argv this product builds therefore names both
 * explicitly, from one place: the defaults below, overridable per install
 * through `PWB_CLAUDE_MODEL` and `PWB_CLAUDE_EFFORT`.
 */

/** The levels `claude --effort` accepts; anything else is a configuration error, not a fallback. */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number];

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'high';

export const CLAUDE_MODEL_VARIABLE = 'PWB_CLAUDE_MODEL';
export const CLAUDE_EFFORT_VARIABLE = 'PWB_CLAUDE_EFFORT';

export interface ClaudeInvocation {
  model: string;
  effort: ClaudeEffort;
}

function isEffort(value: string): value is ClaudeEffort {
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The configured model and effort, or the defaults. A variable that is set but
 * malformed is an error rather than a silent fallback, so a typo fails startup
 * instead of quietly running every worker on the wrong model.
 */
export function claudeInvocationFromEnvironment(env: NodeJS.ProcessEnv = process.env): ClaudeInvocation {
  const rawModel = env[CLAUDE_MODEL_VARIABLE];
  const model = rawModel === undefined ? DEFAULT_CLAUDE_MODEL : rawModel.trim();
  if (rawModel !== undefined && (model === '' || /\s/.test(model))) {
    throw new Error(`${CLAUDE_MODEL_VARIABLE} must name a single model, such as ${DEFAULT_CLAUDE_MODEL}.`);
  }
  const rawEffort = env[CLAUDE_EFFORT_VARIABLE];
  if (rawEffort === undefined) return { model, effort: DEFAULT_CLAUDE_EFFORT };
  const effort = rawEffort.trim();
  if (!isEffort(effort)) {
    throw new Error(`${CLAUDE_EFFORT_VARIABLE} must be one of ${CLAUDE_EFFORT_LEVELS.join(', ')}.`);
  }
  return { model, effort };
}

/** The flags every Claude argv in this product carries, in one spelling. */
export function claudeModelFlags(invocation: ClaudeInvocation): string[] {
  return ['--model', invocation.model, '--effort', invocation.effort];
}

/** An explicit option wins over the environment; the environment is still validated when neither is given. */
export function resolveClaudeInvocation(options: Partial<ClaudeInvocation> = {}, env: NodeJS.ProcessEnv = process.env): ClaudeInvocation {
  const configured = claudeInvocationFromEnvironment(env);
  return { model: options.model ?? configured.model, effort: options.effort ?? configured.effort };
}
