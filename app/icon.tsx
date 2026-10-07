import { ImageResponse } from 'next/og';
import { theme } from '@/themes';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

export default function Icon() {
  const shape = theme.shape === 'hex' ? 'polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)' : 'circle(50%)';
  return new ImageResponse(
    (
      <div style={{ width: 64, height: 64, display: 'flex', background: theme.palette.base }}>
        <div style={{ width: 52, height: 52, margin: 6, background: `linear-gradient(180deg, ${theme.palette.accentSoft}, ${theme.palette.accent})`, clipPath: shape }} />
      </div>
    ),
    size,
  );
}
