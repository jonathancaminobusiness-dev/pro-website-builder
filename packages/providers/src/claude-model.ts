/**
 * Which model the product's Claude workers run on, and how hard they think.
 *
 * Left unset, `claude` runs on whatever the machine's Claude Code default
 * happens to be, so two checkouts of this repo could answer the same task with
 * different models. Every Claude argv this product builds therefore names both
 * explicitly, from the one pin below.
 */

export const CLAUDE_MODEL = 'claude-opus-5';
export const CLAUDE_EFFORT = 'high';

/** The flags every Claude argv in this product carries, in one spelling. */
export function claudeModelFlags(): string[] {
  return ['--model', CLAUDE_MODEL, '--effort', CLAUDE_EFFORT];
}
