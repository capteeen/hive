import { ImageResponse } from 'next/og';
import { hiveSummary } from '@/lib/server/hive-summary';
import { theme } from '@/themes';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = `${theme.name} ${theme.unit}`;

const HEX = 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)';
const SHAPE = theme.shape === 'hex' ? HEX : 'circle(50%)';

/**
 * OG image per unit: a faux-3D render of its cell (depth = holders, fill = honey,
 * colour = state), name, honey, bees and state. Built from clipped divs so it
 * renders in Satori without WebGL. Only a hive the public may see (or a demo hive while demo hives are on)
 * gets its numbers; any other address renders an empty cell.
 */
export default async function OG({ params }: { params: { ca: string } }) {
  const h = await hiveSummary(params.ca);
  const p = theme.palette;
  const name = h?.name ?? `A ${theme.unit}`;
  const ticker = h?.ticker ?? '';
  const honey = h?.honey ?? 0;
  const bees = h?.bees ?? 0;
  const state = h?.state ?? 'working';
  const biggest = !!h?.biggest;
  const liquid = state === 'abandoned' ? '#3a362f' : state === 'starving' ? p.starving : biggest ? p.royal : p.accent;
  const wallL = state === 'working' ? '#5a3d10' : '#2f2b27';
  const wallR = state === 'working' ? '#8a5f1c' : '#45403a';
  const rim = state === 'working' ? '#b8852e' : '#5a544d';
  const cx = 300;
  const cy = 350; // base of the prism
  const R = 150; // hex radius (x)
  const ry = 0.5; // isometric squash
  const depth = Math.round(50 + 150 * Math.min(1, Math.log10(bees + 1) / 3.6));
  const fill = state === 'abandoned' ? 0.06 : 0.1 + 0.85 * Math.sqrt(Math.min(1, honey / 60));
  const hex = (r: number, y: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 6) * (2 * i + 1);
      return `${(cx + Math.cos(a) * r).toFixed(1)},${(y + Math.sin(a) * r * ry).toFixed(1)}`;
    }).join(' ');
  const topY = cy - depth;
  const inner = R * 0.84;
  const liqY = topY + (1 - fill) * Math.min(depth * 0.7, 90);
  const c = (a: number, r: number, y: number) => `${(cx + Math.cos(a) * r).toFixed(1)},${(y + Math.sin(a) * r * ry).toFixed(1)}`;
  // vertex angles (SVG y down): 0 lower-right, 1 bottom, 2 lower-left, 3 upper-left, 4 top, 5 upper-right
  const A = [Math.PI / 6, Math.PI / 2, (5 * Math.PI) / 6, (7 * Math.PI) / 6, (3 * Math.PI) / 2, (11 * Math.PI) / 6];
  const face = (i: number, j: number, r: number, y0: number, y1: number) => `${c(A[i], r, y0)} ${c(A[j], r, y0)} ${c(A[j], r, y1)} ${c(A[i], r, y1)}`;
  // outer side faces that face the viewer (the four lower edges)
  const faceLL = face(2, 3, R, topY, cy);
  const faceL = face(1, 2, R, topY, cy);
  const faceR = face(0, 1, R, topY, cy);
  const faceRR = face(5, 0, R, topY, cy);
  // inner back walls, visible through the opening down to the liquid surface
  const backL = face(3, 4, inner, topY, liqY);
  const backR = face(4, 5, inner, topY, liqY);
  const svgLeft = (
    <svg width="600" height="630" viewBox="0 0 600 630" style={{ position: 'absolute', left: 0, top: 0 }}>
      <ellipse cx={cx} cy={cy + 30} rx="230" ry="90" fill={p.accent} opacity="0.08" />
      <polygon points={faceLL} fill={wallL} opacity="0.8" />
      <polygon points={faceL} fill={wallL} />
      <polygon points={faceR} fill={wallR} />
      <polygon points={faceRR} fill={wallR} opacity="0.8" />
      <polygon points={hex(R, topY)} fill={rim} />
      <polygon points={hex(inner, topY)} fill="#120c06" />
      <polygon points={backL} fill="#2a1d0c" />
      <polygon points={backR} fill="#3a2910" />
      <polygon points={hex(inner, liqY)} fill={liquid} opacity="0.96" />
      <ellipse cx={cx - 40} cy={liqY - 6} rx="46" ry="10" fill="#ffffff" opacity="0.3" />
    </svg>
  );
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: p.base, color: p.text, fontFamily: 'sans-serif', position: 'relative' }}>
        {svgLeft}
        <div style={{ position: 'absolute', left: 600, top: 90, display: 'flex', flexDirection: 'column', width: 540 }}>
          <div style={{ display: 'flex', fontSize: 20, letterSpacing: 4, textTransform: 'uppercase', color: p.accent }}>{theme.name}</div>
          <div style={{ display: 'flex', fontSize: 64, fontWeight: 700, lineHeight: 1.05, marginTop: 16 }}>{name}</div>
          <div style={{ display: 'flex', fontSize: 30, color: p.accentSoft, marginTop: 6 }}>${ticker}</div>
          <div style={{ display: 'flex', gap: 40, marginTop: 44 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', fontSize: 18, letterSpacing: 3, textTransform: 'uppercase', opacity: 0.6 }}>{theme.copy.resource}</div>
              <div style={{ display: 'flex', fontSize: 40, fontWeight: 700 }}>{honey.toFixed(2)} SOL</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', fontSize: 18, letterSpacing: 3, textTransform: 'uppercase', opacity: 0.6 }}>{theme.holderPlural}</div>
              <div style={{ display: 'flex', fontSize: 40, fontWeight: 700 }}>{bees.toLocaleString('en-US')}</div>
            </div>
          </div>
          <div style={{ marginTop: 36, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 18, height: 18, display: 'flex', background: liquid, clipPath: SHAPE }} />
            <div style={{ display: 'flex', fontSize: 24, textTransform: 'uppercase', letterSpacing: 3, color: state === 'working' ? p.accent : p.starving }}>{biggest ? `biggest ${theme.unit}` : state}</div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
