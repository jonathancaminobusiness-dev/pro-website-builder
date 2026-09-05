import { type RasterJob, type RasterProvider, type RasterRequest } from './raster.js';

export class FakeRasterProvider implements RasterProvider {
  private readonly jobs = new Map<string, RasterJob>();

  async submit(request: RasterRequest): Promise<RasterJob> {
    const existing = this.jobs.get(request.digest);
    if (existing) return existing;
    const job: RasterJob = { ...request, status: 'succeeded', uri: `fake://${request.digest}`, provenance: { prompt: request.prompt, model: request.model, aspect: request.aspect, status: 'succeeded', license: 'fixture-generated', termsNote: 'Deterministic fake provider for tests.', identityVersionId: request.identityVersionId } };
    this.jobs.set(request.digest, job);
    return job;
  }
}
