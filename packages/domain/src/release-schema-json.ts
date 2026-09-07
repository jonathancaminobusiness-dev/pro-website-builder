import { inlinedJsonSchema, stagePatchSchemas } from './schema-json.js';
import { releaseCritiqueSchema, releaseSummarySchema } from './release.js';

/**
 * The closed answers a finalization worker may return.
 *
 * A critic answers with a critique and never with a patch. The patch-refiner
 * answers with a finalization-stage patch — the same schema the PatchGate
 * validates — so a proposal the gate would refuse cannot be produced in the
 * first place.
 */
export const releaseJsonSchemas = {
  ReleaseCritique: inlinedJsonSchema(releaseCritiqueSchema),
  ReleaseSummary: inlinedJsonSchema(releaseSummarySchema),
  FinalizationPatch: inlinedJsonSchema(stagePatchSchemas.finalization),
} as const;
