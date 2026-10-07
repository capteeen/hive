import { theme } from '@/themes';

export default function Steps() {
  return (
    <section className="mx-auto mt-6 max-w-[1400px] px-4 sm:px-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {theme.copy.steps.map((s, i) => (
          <div key={i} className="shape-card glass relative p-6 transition-transform duration-900 hover:-translate-y-1">
            <div className="shape-hex flex h-10 w-10 items-center justify-center bg-accent/15 font-heading text-sm font-semibold text-accent">0{i + 1}</div>
            <h3 className="mt-5 font-heading text-xl font-semibold tracking-tight">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-text/70">{s.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {theme.copy.feature.map((f, i) => (
          <div key={i} className="px-2 py-3">
            <h4 className="font-heading text-base font-semibold tracking-tight">{f.title}</h4>
            <p className="mt-1.5 text-sm leading-relaxed text-text/60">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
