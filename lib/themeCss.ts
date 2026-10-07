import { theme } from '@/themes';

function rgb(hex: string) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function darken(hex: string, f: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** CSS variables derived from the theme. Injected once in the root layout. */
export function themeCss() {
  const p = theme.palette;
  return `
:root{
--c-base:${rgb(p.base)};--c-surface:${rgb(p.surface)};--c-accent:${rgb(p.accent)};--c-soft:${rgb(p.accentSoft)};
--c-text:${rgb(p.text)};--c-royal:${rgb(p.royal)};--c-starving:${rgb(p.starving)};--c-raid:${rgb(p.raid)};
--f-heading:${theme.fonts.heading};--f-body:${theme.fonts.body};--f-heading-weight:${theme.fonts.headingWeight};--f-tracking:${theme.fonts.tracking};
}
html[data-mode='day']{--c-base:${rgb(p.dayBase)};--c-text:${rgb(p.dayText)};--c-surface:255 255 255;--c-royal:${rgb(p.accent)};--c-accent:${rgb(darken(p.accent, 0.78))};--c-soft:${rgb(p.accent)};--c-starving:${rgb(darken(p.starving, 0.85))};}
`;
}
