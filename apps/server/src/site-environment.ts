/**
 * The origin and the site name a release is compiled for.
 *
 * The origin is written into every canonical URL, into `sitemap.xml` and into
 * `robots.txt`, so it is part of the bundle digest: a compile site that ignores
 * it produces bytes no evidence runner ever measured, and the gate credits a
 * digest nobody looked at. Every entry point that compiles a release — the
 * server, `run:fixture` and `run:release` — reads the two variables here, so
 * they cannot drift apart.
 */
export interface SiteEnvironment {
  siteUrl: string;
  siteName: string;
}

export function siteFromEnvironment(env: NodeJS.ProcessEnv = process.env): SiteEnvironment {
  return {
    siteUrl: env.PWB_SITE_URL ?? 'https://site.invalid',
    siteName: env.PWB_SITE_NAME ?? 'pro-website-builder',
  };
}
