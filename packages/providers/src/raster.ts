export type RasterStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'not_configured';
export interface RasterRequest { id: string; digest: string; prompt: string; model: string; aspect: string; identityVersionId: string; }
export interface RasterJob extends RasterRequest { status: RasterStatus; uri?: string; error?: string; provenance: { prompt: string; model: string; aspect: string; status: RasterStatus; cost?: number; license: string; termsNote: string; identityVersionId: string; }; }
export interface RasterProvider { submit(request: RasterRequest, signal?: AbortSignal): Promise<RasterJob>; }
