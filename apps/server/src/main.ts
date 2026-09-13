import type { AddressInfo } from 'node:net';
import { startServer } from './index.js';

/**
 * The command line entry. It is its own file so that `startServer` stays
 * importable from a test runner that transpiles modules — a suite that drives
 * the whole gate chain over HTTP has to wire the server exactly as this does.
 */
startServer()
  .then(({ api, preview }) => { const { port } = api.address() as AddressInfo; console.log(`pro-website-builder server listening on http://127.0.0.1:${port}; preview on ${preview.origin}`); })
  .catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Server failed.'); process.exitCode = 1; });
