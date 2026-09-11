import { IDENTITY_BRIEFING, IDENTITY_BRIEFING_MAX_LENGTH } from '@pwb/domain/briefing';

/** The compatibility briefing used only when an older caller omits the new field. */
export { IDENTITY_BRIEFING, IDENTITY_BRIEFING_MAX_LENGTH, INVALID_IDENTITY_BRIEFING } from '@pwb/domain/briefing';

export const LEGACY_INVALID_BRIEFING_MESSAGE = `Esta execução legada foi encerrada porque o briefing salvo é inválido. Os dados foram preservados; crie uma nova execução com um briefing entre 1 e ${IDENTITY_BRIEFING_MAX_LENGTH} caracteres.`;

export class BriefingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BriefingValidationError';
  }
}

/** The server's one briefing boundary; an omitted field keeps the compatibility briefing. */
export function normalizeIdentityBriefing(value: unknown): string {
  if (value === undefined) return IDENTITY_BRIEFING;
  if (typeof value !== 'string') throw new BriefingValidationError('O briefing deve ser um texto.');
  const briefing = value.trim();
  if (briefing.length === 0) throw new BriefingValidationError('O briefing é obrigatório e não pode estar vazio.');
  if (briefing.length > IDENTITY_BRIEFING_MAX_LENGTH) throw new BriefingValidationError(`O briefing não pode ter mais de ${IDENTITY_BRIEFING_MAX_LENGTH} caracteres.`);
  return briefing;
}
