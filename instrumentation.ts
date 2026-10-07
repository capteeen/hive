/**
 * Next.js instrumentation hook (experimental.instrumentationHook in next.config.js): register() runs
 * once when a server process starts. In mock mode it starts the in-process queen engine ticker
 * (lib/server/engine-autorun.ts) so remote mock hives seal, store, swarm and starve locally. In live
 * mode it does nothing: Vercel Cron calls /api/cron/hourly and /api/cron/refresh instead.
 */
export async function register() {
  // The import sits inside the runtime check so the edge bundle never includes the engine.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startEngineAutorun } = await import('./lib/server/engine-autorun');
    startEngineAutorun();
  }
}
