import Link from 'next/link';
import type { ComponentProps } from 'react';

type Variant = 'honey' | 'ghost';
type Base = { variant?: Variant; size?: 'sm' | 'md' | 'lg'; className?: string; children: React.ReactNode };
type ButtonProps = Base & Omit<ComponentProps<'button'>, 'className' | 'children'> & { href?: undefined };
type LinkProps = Base & { href: string; target?: string; rel?: string };

const sizes = { sm: 'h-9 text-sm', md: 'h-11 text-sm', lg: 'h-13 text-base' };

export default function HexButton(props: ButtonProps | LinkProps) {
  const { variant = 'honey', size = 'md', className = '', children } = props;
  const cls = `shape-btn inline-flex items-center justify-center gap-2 font-heading font-semibold tracking-tight whitespace-nowrap select-none ${sizes[size]} ${variant === 'honey' ? 'btn-honey' : 'btn-ghost'} ${className}`;
  if ('href' in props && props.href) {
    const { href, target, rel } = props;
    return (
      <Link href={href} target={target} rel={rel} className={cls}>
        {children}
      </Link>
    );
  }
  const { variant: _v, size: _s, className: _c, children: _ch, href: _h, ...rest } = props as ButtonProps;
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
