import Link from 'next/link';

export default function Section({ eyebrow, title, action, children, className = '', id }: { eyebrow?: string; title: string; action?: { href: string; label: string }; children: React.ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`mx-auto max-w-[1400px] px-4 sm:px-6 ${className}`}>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          {eyebrow && <div className="text-[11px] uppercase tracking-[0.18em] text-text/55">{eyebrow}</div>}
          <h2 className="mt-1 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
        </div>
        {action && (
          <Link href={action.href} className="text-sm text-accent hover:text-soft">
            {action.label} →
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
