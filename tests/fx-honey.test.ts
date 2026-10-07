import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Honey and the ambience controls (components/fx): the drips, backdrop and pool markup, the nav's
 * Bees switch and its storage, the pack theme getting none of it, the CSS that keeps it calm and
 * below modals, and the coin splashes made rarer now that bees and drips share the stage.
 */

// the vitest config keeps tsconfig's jsx: 'preserve', which esbuild turns into classic React.createElement
(globalThis as unknown as { React: typeof React }).React = React;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/themes');
  vi.doUnmock('next/navigation');
});

const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');
/** The declarations of the first rule whose selector list is exactly `sel`. */
const rule = (sel: string) => {
  const i = css.indexOf(`\n${sel} {`);
  expect(i, `rule ${sel}`).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf('}', i));
};

describe('honey markup', () => {
  it('the nav drips: aria-hidden, a film plus drips of varied length, some letting droplets go, some desktop-only', async () => {
    const { HoneyDrips, NAV_DRIPS, dripPath, dropTop } = await import('@/components/fx/Honey');
    const html = renderToStaticMarkup(React.createElement(HoneyDrips));
    expect(html).toMatch(/^<div class="honey-drips" aria-hidden="true">/);
    expect(html).toContain('class="honey-film"');
    expect(html.match(/class="honey-drip"/g)).toHaveLength(NAV_DRIPS.length);
    expect(html.match(/class="honey-drop"/g)).toHaveLength(NAV_DRIPS.filter((d) => d.drop).length);
    expect(NAV_DRIPS.filter((d) => d.drop).length).toBeGreaterThanOrEqual(3);
    expect(NAV_DRIPS.filter((d) => !d.wide).length).toBeGreaterThanOrEqual(4); // phones keep a few
    const lens = new Set(NAV_DRIPS.map((d) => d.len));
    expect(lens.size).toBeGreaterThanOrEqual(8);
    for (const d of NAV_DRIPS) {
      expect(dripPath(d.len, d.r)).toMatch(/^M0 0H18C[-0-9. CVAZ]+Z$/);
      expect(dripPath(d.len, d.r)).not.toMatch(/NaN|Infinity/);
      // the droplet starts at the bulb's bottom at the stretch's peak (scaleY 1.16)
      expect(dropTop(d)).toBeGreaterThan(d.len);
    }
  });

  it('backdrop and footer pool are decoration only', async () => {
    const { HoneyBackdrop, HoneyPool } = await import('@/components/fx/Honey');
    expect(renderToStaticMarkup(React.createElement(HoneyBackdrop))).toBe('<div class="honey-bg" aria-hidden="true"></div>');
    expect(renderToStaticMarkup(React.createElement(HoneyPool))).toMatch(/^<div class="honey-pool" aria-hidden="true">/);
  });
});

describe('honey on click', () => {
  const fakeHost = () => {
    const kids: { removed: boolean; remove: () => void; style: Record<string, string>; className: string; addEventListener: () => void }[] = [];
    const host = {
      get childElementCount() {
        return kids.filter((k) => !k.removed).length;
      },
      get firstElementChild() {
        return kids.find((k) => !k.removed) ?? null;
      },
      appendChild: (k: (typeof kids)[number]) => (kids.push(k), k),
      ownerDocument: {
        createElement: () => {
          const k = { removed: false, style: {} as Record<string, string>, className: '', addEventListener: () => {}, remove: () => void (k.removed = true) };
          return k;
        },
      },
    };
    return { host: host as unknown as Parameters<typeof import('@/components/fx/HoneyTap').spawnTap>[0], kids };
  };

  it('a splash sits at the pointer via left/top (its animation scales, which would also scale a translate)', async () => {
    const { spawnTap } = await import('@/components/fx/HoneyTap');
    const { host } = fakeHost();
    const d = spawnTap(host, 700.4, 760.6);
    expect(d.className).toBe('fx-tap');
    expect(d.style.left).toBe('700px');
    expect(d.style.top).toBe('761px');
    expect(d.style.transform).toBeUndefined();
    // and the CSS animates scale on it: positioning it with transform would land it at 1.25 × (x, y)
    expect(css.slice(css.indexOf('@keyframes fxTap {'), css.indexOf('@keyframes fxTapRing'))).toMatch(/scale: 1\.25/);
  });

  it("the caught bee's splash is placed the same way", () => {
    const src = readFileSync(path.resolve(__dirname, '../components/fx/Swarm.tsx'), 'utf8');
    expect(src).toMatch(/className="bee-splash" style=\{\{ left: splash\.x, top: splash\.y \}\}/);
    expect(css.slice(css.indexOf('@keyframes beeSplash {'), css.indexOf('@keyframes beeRing'))).toMatch(/scale:/);
  });

  it('keeps at most a few splashes alive', async () => {
    const { spawnTap, MAX_TAPS } = await import('@/components/fx/HoneyTap');
    const { host, kids } = fakeHost();
    for (let i = 0; i < 10; i++) spawnTap(host, i, i);
    expect(kids.filter((k) => !k.removed)).toHaveLength(MAX_TAPS);
    expect(kids.filter((k) => !k.removed).map((k) => k.style.left)).toEqual(['6px', '7px', '8px', '9px']);
  });
});

describe('the Bees switch', () => {
  it('defaults to on; "0" is off; storage that throws counts as on and saving never throws', async () => {
    const { readAmbience, saveAmbience, AMBIENCE_KEY } = await import('@/components/fx/ambienceStore');
    expect(readAmbience(null)).toBe(true);
    expect(readAmbience({ getItem: () => null })).toBe(true);
    expect(readAmbience({ getItem: (k) => (k === AMBIENCE_KEY ? '0' : null) })).toBe(false);
    expect(readAmbience({ getItem: () => '1' })).toBe(true);
    const boom = () => {
      throw new Error('SecurityError');
    };
    expect(readAmbience({ getItem: boom })).toBe(true);
    expect(() => saveAmbience({ setItem: boom }, false)).not.toThrow();
    const saved: Record<string, string> = {};
    saveAmbience({ setItem: (k, v) => void (saved[k] = v) }, false);
    expect(saved).toEqual({ [AMBIENCE_KEY]: '0' });
  });

  it('toggling remembers the choice and mirrors it onto <html data-ambience>', async () => {
    const store: Record<string, string> = {};
    const html = { dataset: {} as Record<string, string> };
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) } });
    vi.stubGlobal('document', { documentElement: html });
    try {
      const { useAmbience, AMBIENCE_KEY } = await import('@/components/fx/ambienceStore');
      useAmbience.getState().load();
      expect(useAmbience.getState().on).toBe(true);
      expect(html.dataset.ambience).toBe('on');
      useAmbience.getState().toggle();
      expect(useAmbience.getState().on).toBe(false);
      expect(store[AMBIENCE_KEY]).toBe('0');
      expect(html.dataset.ambience).toBe('off');
      // a new visit reads it back
      vi.resetModules();
      const again = await import('@/components/fx/ambienceStore');
      again.useAmbience.getState().load();
      expect(again.useAmbience.getState().on).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the nav', () => {
  const renderNav = async (themeId: 'hive' | 'pack') => {
    vi.resetModules();
    vi.doMock('next/navigation', () => ({ usePathname: () => '/' }));
    if (themeId === 'pack') {
      const { pack } = await import('@/themes/pack');
      vi.doMock('@/themes', () => ({ theme: pack }));
    }
    const { default: Nav } = await import('@/components/Nav');
    return renderToStaticMarkup(React.createElement(Nav));
  };

  it('hive: honey drips under the nav, a Bees switch (on by default) next to the sound switch, a bee on the logo', async () => {
    const html = await renderNav('hive');
    expect(html).toContain('class="honey-drips"');
    const toggles = html.match(/<button[^>]*aria-label="Ambient bees"[^>]*>/g) ?? [];
    expect(toggles.length).toBe(2); // the top row from sm up, the second row on phones
    for (const t of toggles) expect(t).toContain('aria-pressed="true"');
    expect(html).toMatch(/aria-label="Click sounds"[\s\S]*aria-label="Ambient bees"/);
    expect(html).toMatch(/<span data-perch="true" class="shape-hex[^"]*logo-honey/);
  });

  it('pack: no drips, no switch, no logo bee', async () => {
    const html = await renderNav('pack');
    expect(html).not.toContain('honey-drips');
    expect(html).not.toContain('aria-label="Ambient');
    expect(html).not.toContain('logo-honey');
    expect(html).toContain('data-perch');
  });
});

describe('ambience wiring', () => {
  it("the hive theme's critter is the swarm; pack has none", async () => {
    const { critterFor } = await import('@/components/fx/Ambient');
    expect(critterFor('hive')).not.toBeNull();
    expect(critterFor('pack')).toBeNull();
    const src = readFileSync(path.resolve(__dirname, '../components/fx/Ambient.tsx'), 'utf8');
    expect(src).toMatch(/hive: Swarm/);
    // off switch, reduced motion, hidden tab and the open wizard all unmount the effects
    expect(src).toMatch(/if \(reduced \|\| !visible \|\| launching \|\| !on\) return null;/);
  });

  it('coin splashes are rarer now that bees and drips share the stage (12–24 s apart, the first after 6 s)', async () => {
    const { EVERY_MS, FIRST_MS } = await import('@/components/fx/MoneySplash');
    expect(EVERY_MS[0]).toBeGreaterThanOrEqual(12000);
    expect(EVERY_MS[1]).toBeLessThanOrEqual(24000);
    expect(FIRST_MS[0]).toBeGreaterThanOrEqual(6000);
  });
});

describe('ambience CSS', () => {
  it('the effects layer sits above the nav (z 40) and below modals (z 50), and only bees and coins catch the pointer', () => {
    const r = rule('.fx-layer');
    const z = Number(/z-index:\s*(\d+)/.exec(r)?.[1]);
    expect(z).toBeGreaterThan(40);
    expect(z).toBeLessThan(50);
    expect(r).toMatch(/pointer-events:\s*none/);
    expect(rule('.fx-layer .fxb')).toMatch(/pointer-events:\s*auto/);
    expect(rule('.honey-drips')).toMatch(/pointer-events:\s*none/);
    expect(rule('.honey-bg')).toMatch(/pointer-events:\s*none/);
    expect(rule('.honey-bg')).toMatch(/z-index:\s*-1/);
  });

  it('reduced motion and the Bees switch stop the drips; reduced motion hides the effects layer', () => {
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
    expect(reduced).toMatch(/\.fx-layer \{\s*display: none;/);
    expect(reduced).toMatch(/\.honey-drip,\s*\.honey-drop \{\s*animation: none;/);
    expect(css).toMatch(/html\[data-ambience='off'\] \.honey-drip,\s*html\[data-ambience='off'\] \.honey-drop \{\s*animation: none;/);
  });

  it('the page colour moved to <html> so the honey backdrop shows through <body>', () => {
    expect(css).toMatch(/\nbody \{\s*background: transparent;/);
  });

  it('honey selection, amber scrollbars and a honey focus ring', () => {
    expect(rule('::selection')).toMatch(/--c-soft/);
    expect(css).toMatch(/scrollbar-color: rgb\(var\(--c-accent\)/);
    expect(css).toMatch(/:focus-visible:not\([^)]*\) \{\s*outline: 2px solid rgb\(var\(--c-focus\)\);/);
  });

  it('animations on the drips, bees and splashes only touch transform / opacity', () => {
    for (const name of ['honeyStretch', 'honeyFall', 'fxbFlap', 'fxbFlick', 'fxTap', 'fxTapRing', 'fxTapDrops', 'fxbIn']) {
      const i = css.indexOf(`@keyframes ${name} {`);
      expect(i, name).toBeGreaterThanOrEqual(0);
      let depth = 0;
      let j = css.indexOf('{', i);
      const startBody = j;
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}' && --depth === 0) break;
      }
      const props = [...css.slice(startBody, j).matchAll(/([a-z-]+):/g)].map((m) => m[1]);
      for (const p of props) expect(['transform', 'opacity', 'scale', 'translate', 'animation-timing-function'], `${name}: ${p}`).toContain(p);
    }
  });
});
