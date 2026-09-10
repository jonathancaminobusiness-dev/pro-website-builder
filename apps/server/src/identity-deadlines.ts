import { defaultIdentityDeadlines, identityCritics, type IdentityCriticId, type IdentityStageDeadlines } from '@pwb/stage-identity';
import { CLAUDE_RUNNER_TIMEOUT_MS, CODEX_RUNNER_TIMEOUT_MS } from '@pwb/providers';

const GLOBAL_CRITIC_DEADLINE = 'PWB_IDENTITY_CRITIC_DEADLINE_MS';

function criticDeadlineVariable(criticId: IdentityCriticId): string {
  return `PWB_IDENTITY_CRITIC_${criticId.replaceAll('-', '_').toUpperCase()}_DEADLINE_MS`;
}

function positiveMilliseconds(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer in milliseconds.`);
  return value;
}

export function identityDeadlinesFromEnvironment(env: NodeJS.ProcessEnv = process.env): Partial<IdentityStageDeadlines> | undefined {
  const critic = positiveMilliseconds(env, GLOBAL_CRITIC_DEADLINE);
  const criticById: Partial<Record<IdentityCriticId, number>> = {};
  for (const definition of identityCritics) {
    const deadline = positiveMilliseconds(env, criticDeadlineVariable(definition.id));
    if (deadline !== undefined) criticById[definition.id] = deadline;
  }
  if (critic === undefined && Object.keys(criticById).length === 0) return undefined;
  return {
    ...(critic !== undefined ? { critic } : {}),
    ...(Object.keys(criticById).length > 0 ? { criticById } : {}),
  };
}

export function identityProviderTimeoutMs(deadlines: Partial<IdentityStageDeadlines> | undefined): number {
  // Mirror IdentityStage's precedence: an explicit role override replaces the
  // role default for every critic, while named overrides remain more specific.
  const criticById = deadlines?.critic !== undefined
    ? deadlines.criticById
    : { ...defaultIdentityDeadlines.criticById, ...deadlines?.criticById };
  const configured = [deadlines?.critic ?? defaultIdentityDeadlines.critic, ...Object.values(criticById ?? {})].filter((deadline): deadline is number => typeof deadline === 'number');
  return Math.max(CLAUDE_RUNNER_TIMEOUT_MS, CODEX_RUNNER_TIMEOUT_MS, ...configured);
}
