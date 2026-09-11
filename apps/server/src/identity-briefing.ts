import { IDENTITY_BRIEFING, IDENTITY_BRIEFING_MAX_LENGTH } from '@pwb/domain/briefing';

/** The compatibility briefing used only when an older caller omits the new field. */
export { IDENTITY_BRIEFING, IDENTITY_BRIEFING_MAX_LENGTH } from '@pwb/domain/briefing';

export const LEGACY_INVALID_BRIEFING_MESSAGE = `Esta execução legada foi encerrada porque o briefing salvo é inválido. Os dados foram preservados; crie uma nova execução com um briefing entre 1 e ${IDENTITY_BRIEFING_MAX_LENGTH} caracteres.`;

export class BriefingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BriefingValidationError';
  }
}

/**
 * The server's one briefing boundary. `supplied` is explicit so an omitted
 * legacy field cannot be confused with a supplied undefined value.
 */
export function normalizeIdentityBriefing(value: unknown, supplied: boolean): string {
  if (!supplied) return IDENTITY_BRIEFING;
  if (typeof value !== 'string') throw new BriefingValidationError('O briefing deve ser um texto.');
  const briefing = value.trim();
  if (briefing.length === 0) throw new BriefingValidationError('O briefing é obrigatório e não pode estar vazio.');
  if (briefing.length > IDENTITY_BRIEFING_MAX_LENGTH) throw new BriefingValidationError(`O briefing não pode ter mais de ${IDENTITY_BRIEFING_MAX_LENGTH} caracteres.`);
  return briefing;
}
