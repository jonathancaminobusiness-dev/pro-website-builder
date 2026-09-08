import type { RasterJob, RasterProvider, RasterRequest } from './raster.js';

export interface HiggsfieldMcpTransport { callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<{ uri?: string; license?: string; termsNote?: string }>; }

export type HiggsfieldMcpOptions = { configured: false } | { configured: true; transport: HiggsfieldMcpTransport };

export class HiggsfieldMcpProvider implements RasterProvider {
  constructor(private readonly options: HiggsfieldMcpOptions = { configured: false }) {}

  async submit(request: RasterRequest, signal?: AbortSignal): Promise<RasterJob> {
    const provenance = (status: RasterJob['status'], license: string, termsNote: string): RasterJob['provenance'] =>
      ({ prompt: request.prompt, model: request.model, aspect: request.aspect, status, license, termsNote, identityVersionId: request.identityVersionId });
    if (!this.options.configured) return { ...request, status: 'not_configured', provenance: provenance('not_configured', 'pending provider terms', 'Higgsfield MCP is not configured; placeholder asset only.') };
    try {
      const result = await this.options.transport.callTool('higgsfield_generate_image', { prompt: request.prompt, model: request.model, aspect: request.aspect, idempotency_key: request.digest }, signal);
      // An answer that names no image is a recorded failure, never a job left
      // looking unfinished: the owner has to be able to tell the two apart.
      if (!result.uri) throw new Error('The MCP tool answered with no image.');
      return {
        ...request,
        status: 'succeeded',
        uri: result.uri,
        provenance: provenance('succeeded', result.license ?? 'pending provider terms', result.termsNote ?? 'Higgsfield MCP output requires owner review.'),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The Higgsfield MCP call did not complete.';
      return { ...request, status: 'failed', error: reason, provenance: provenance('failed', 'pending provider terms', `Higgsfield MCP returned no image: ${reason}`) };
    }
  }
}
