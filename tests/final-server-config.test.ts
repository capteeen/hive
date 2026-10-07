/**
 * Finding #9: `images.remotePatterns: [{ protocol: 'https', hostname: '**' }]` let /_next/image fetch any
 * https URL (no timeout, no size cap, follows redirects) although next/image is not used anywhere.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('#9 next.config.js image optimizer', () => {
  it('is off, and Next itself refuses to fetch arbitrary hosts with this config', () => {
    const userCfg = require('../next.config.js') as { images?: { unoptimized?: boolean; remotePatterns?: unknown[]; domains?: string[] } };
    // unoptimized: next-server answers 404 for /_next/image before it looks at the URL
    expect(userCfg.images?.unoptimized).toBe(true);
    expect(JSON.stringify(userCfg.images?.remotePatterns ?? [])).not.toContain('**');

    const { ImageOptimizerCache } = require('next/dist/server/image-optimizer.js') as {
      ImageOptimizerCache: { validateParams(req: unknown, query: Record<string, string>, cfg: unknown, dev: boolean): { errorMessage?: string } };
    };
    const { imageConfigDefault } = require('next/dist/shared/lib/image-config.js') as { imageConfigDefault: Record<string, unknown> };
    const nextConfig = { images: { ...imageConfigDefault, ...userCfg.images } };
    for (const url of ['https://169.254.169.254.nip.io/latest/meta-data/', 'https://internal.corp.example/admin.png', 'https://attacker.example/10GB.bin']) {
      const r = ImageOptimizerCache.validateParams({ headers: { accept: 'image/webp' } }, { url, w: '64', q: '75' }, nextConfig, false);
      expect('errorMessage' in r, url).toBe(true);
    }
  });
});
