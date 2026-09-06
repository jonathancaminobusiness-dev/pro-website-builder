import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashJson, type DesignIR } from '@pwb/domain';
import type { RenderedDocument } from '@pwb/renderer';

export interface ExportManifest {
  digest: string;
  directory: string;
  irHash: string;
  rendererVersion: string;
  assets: DesignIR['assets']['items'];
  routes: string[];
}

function routePath(route: string): string {
  const segments = route.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) throw new Error(`Cannot export a route that escapes the export root: ${route}`);
  return [...segments, 'index.html'].join('/');
}

export async function exportStatic(rendered: RenderedDocument, ir: DesignIR, rootDir: string): Promise<ExportManifest> {
  for (const asset of ir.assets.items) {
    if (!asset.provenance.license.trim()) throw new Error(`Cannot export asset ${asset.id} without a license record.`);
  }
  const digest = hashJson({ irHash: rendered.irHash, rendererVersion: rendered.rendererVersion, routes: rendered.routes, css: rendered.css, assets: ir.assets });
  const directory = join(rootDir, digest);
  await mkdir(join(directory, 'assets'), { recursive: true });
  await writeFile(join(directory, 'assets', 'styles.css'), rendered.css, 'utf8');
  for (const route of rendered.routes) {
    const file = join(directory, routePath(route.route));
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, route.html, 'utf8');
  }
  const manifest: ExportManifest = { digest, directory, irHash: rendered.irHash, rendererVersion: rendered.rendererVersion, assets: ir.assets.items, routes: rendered.routes.map((route) => route.route) };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}
