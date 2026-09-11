import { briefingConversationTurnSchema } from './conversation.js';
import { inlinedJsonSchema } from './schema-json.js';

/**
 * The closed shape a briefing-conversation answer must match, as JSON Schema.
 *
 * It lives apart from `conversation.ts` so the Studio can import the contract
 * through the `./conversation` subpath without pulling a schema compiler into
 * its bundle; the server, which has to put this schema in a prompt, imports it
 * from the package root.
 */
export const briefingConversationTurnJsonSchema = inlinedJsonSchema(briefingConversationTurnSchema);
