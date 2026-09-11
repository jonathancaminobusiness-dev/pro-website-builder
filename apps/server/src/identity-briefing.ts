import { IDENTITY_BRIEFING_MAX_LENGTH } from '@pwb/domain/briefing';

/** The compatibility briefing used only when an older caller omits the new field. */
export { IDENTITY_BRIEFING, IDENTITY_BRIEFING_MAX_LENGTH } from '@pwb/domain/briefing';

export class BriefingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BriefingValidationError';
  }
}

/**
 * The server's one briefing boundary, for a briefing a caller actually sent: an
 * empty or oversized one is told why in pt-BR. A caller that omits the field
 * never reaches here — it keeps the fixed compatibility text instead.
 */
export function normalizeIdentityBriefing(value: unknown): string {
  if (typeof value !== 'string') throw new BriefingValidationError('O briefing deve ser um texto.');
  const briefing = value.trim();
  if (briefing.length === 0) throw new BriefingValidationError('O briefing é obrigatório e não pode estar vazio.');
  if (briefing.length > IDENTITY_BRIEFING_MAX_LENGTH) throw new BriefingValidationError(`O briefing não pode ter mais de ${IDENTITY_BRIEFING_MAX_LENGTH} caracteres.`);
  return briefing;
}
