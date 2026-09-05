import type { RasterJob, RasterProvider, RasterRequest } from './raster.js';

export interface HiggsfieldMcpTransport { callTool(name: string, arguments_: Record<string, unknown>): Promise<{ uri?: string; cost?: number; license?: string; termsNote?: string }>; }

export class HiggsfieldMcpProvider implements RasterProvider {
  constructor(private readonly options: { configured: boolean; transport?: HiggsfieldMcpTransport } = { configured: false }) {}

  async submit(request: RasterRequest): Promise<RasterJob> {
    if (!this.options.configured) return { ...request, status: 'not_configured', provenance: { prompt: request.prompt, model: request.model, aspect: request.aspect, status: 'not_configured', license: 'pending provider terms', termsNote: 'Higgsfield MCP is not configured; placeholder asset only.', identityVersionId: request.identityVersionId } };
    if (this.options.transport) {
      const result = await this.options.transport.callTool('higgsfield_generate_image', { prompt: request.prompt, model: request.model, aspect: request.aspect, idempotency_key: request.digest });
      return { ...request, status: result.uri ? 'succeeded' : 'queued', ...(result.uri ? { uri: result.uri } : {}), provenance: { prompt: request.prompt, model: request.model, aspect: request.aspect, status: result.uri ? 'succeeded' : 'queued', ...(result.cost === undefined ? {} : { cost: result.cost }), license: result.license ?? 'pending provider terms', termsNote: result.termsNote ?? 'Higgsfield MCP output requires owner review.', identityVersionId: request.identityVersionId } };
    }
    return { ...request, status: 'queued', provenance: { prompt: request.prompt, model: request.model, aspect: request.aspect, status: 'queued', license: 'pending provider terms', termsNote: 'Higgsfield MCP adapter boundary; async transport is configured by the owner.', identityVersionId: request.identityVersionId } };
  }
}
