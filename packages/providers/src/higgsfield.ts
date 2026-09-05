import type { RasterJob, RasterProvider, RasterRequest } from './raster.js';

export class HiggsfieldMcpProvider implements RasterProvider {
  constructor(private readonly options: { configured: boolean } = { configured: false }) {}

  async submit(request: RasterRequest): Promise<RasterJob> {
    if (!this.options.configured) return { ...request, status: 'not_configured', provenance: { prompt: request.prompt, model: request.model, aspect: request.aspect, status: 'not_configured', license: 'pending provider terms', termsNote: 'Higgsfield MCP is not configured; placeholder asset only.', identityVersionId: request.identityVersionId } };
    return { ...request, status: 'queued', provenance: { prompt: request.prompt, model: request.model, aspect: request.aspect, status: 'queued', license: 'pending provider terms', termsNote: 'Higgsfield MCP adapter boundary; async transport is configured by the owner.', identityVersionId: request.identityVersionId } };
  }
}
