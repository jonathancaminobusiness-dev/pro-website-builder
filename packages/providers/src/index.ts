export * from './claude-runner.js';
export * from './fake-model.js';
export * from './higgsfield.js';
export * from './model.js';
export * from './raster.js';

import { hashJson } from '@pwb/domain';
export function idempotencyKey(input: { stage: string; role: string; baseVersionId: string; inputDigest: string; promptVersion: string; modelAlias: string }): string {
  return hashJson([input.stage, input.role, input.baseVersionId, input.inputDigest, input.promptVersion, input.modelAlias]);
}
