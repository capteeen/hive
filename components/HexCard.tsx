import type { ComponentProps } from 'react';

export default function HexCard({ className = '', children, glow = false, ...rest }: ComponentProps<'div'> & { glow?: boolean }) {
  return (
    <div className={`shape-card glass ${glow ? 'glow' : ''} ${className}`} {...rest}>
      {children}
    </div>
  );
}
