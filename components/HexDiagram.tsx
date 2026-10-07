import { theme } from '@/themes';

interface Node {
  id: string;
  x: number;
  y: number;
  label: string;
  sub?: string;
  tone?: 'accent' | 'royal' | 'raid' | 'grey' | 'muted';
}
interface Edge {
  from: string;
  to: string;
  label?: string;
}

const tones = {
  accent: { fill: 'rgb(var(--c-accent) / 0.16)', stroke: 'rgb(var(--c-accent))', text: 'rgb(var(--c-text))' },
  royal: { fill: 'rgb(var(--c-royal) / 0.18)', stroke: 'rgb(var(--c-royal))', text: 'rgb(var(--c-text))' },
  raid: { fill: 'rgb(var(--c-raid) / 0.16)', stroke: 'rgb(var(--c-raid))', text: 'rgb(var(--c-text))' },
  grey: { fill: 'rgb(var(--c-starving) / 0.2)', stroke: 'rgb(var(--c-starving))', text: 'rgb(var(--c-text))' },
  muted: { fill: 'rgb(var(--c-surface))', stroke: 'rgb(var(--c-accent) / 0.4)', text: 'rgb(var(--c-text))' },
};

function hexPath(cx: number, cy: number, r: number) {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 6) * (2 * i + 1);
    pts.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return pts.join(' ');
}

/** Simple hex-node diagram, pure SVG, theme-colored. */
export default function HexDiagram({ nodes, edges, width = 900, height = 360, r = 54 }: { nodes: Node[]; edges: Edge[]; width?: number; height?: number; r?: number }) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const circle = theme.shape === 'circle';
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="rgb(var(--c-accent))" />
        </marker>
      </defs>
      {edges.map((e, i) => {
        const a = byId[e.from];
        const b = byId[e.to];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const ux = dx / d;
        const uy = dy / d;
        const x1 = a.x + ux * (r + 4);
        const y1 = a.y + uy * (r + 4);
        const x2 = b.x - ux * (r + 6);
        const y2 = b.y - uy * (r + 6);
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgb(var(--c-accent) / 0.6)" strokeWidth="1.5" markerEnd="url(#arrow)" />
            {e.label && (
              <text x={mx} y={my - 8} textAnchor="middle" fontSize="12" fill="rgb(var(--c-text) / 0.7)" fontFamily="var(--f-body)">
                {e.label}
              </text>
            )}
          </g>
        );
      })}
      {nodes.map((n) => {
        const t = tones[n.tone ?? 'muted'];
        return (
          <g key={n.id}>
            {circle ? <circle cx={n.x} cy={n.y} r={r} fill={t.fill} stroke={t.stroke} strokeWidth="1.5" /> : <polygon points={hexPath(n.x, n.y, r)} fill={t.fill} stroke={t.stroke} strokeWidth="1.5" />}
            <text x={n.x} y={n.y + (n.sub ? -2 : 5)} textAnchor="middle" fontSize={n.label.length > 11 ? 11.5 : 14} fontWeight="600" fill={t.text} fontFamily="var(--f-heading)">
              {n.label}
            </text>
            {n.sub && (
              <text x={n.x} y={n.y + 16} textAnchor="middle" fontSize="11" fill="rgb(var(--c-text) / 0.65)" fontFamily="var(--f-body)">
                {n.sub}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
