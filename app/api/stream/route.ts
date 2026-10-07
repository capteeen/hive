import { createHash } from 'node:crypto';
import { getDb } from '@/lib/server/db';
import type { StreamEvent } from '@/lib/shared/api';

/**
 * GET /api/stream: Server-Sent Events from the file store's in-process change feed.
 *   event: hive | action | harvest
 *   data:  the RemoteHive / RemoteAction / RemoteHarvest as JSON
 * plus `event: ping` (data: server ms) every 20s. It keeps proxies from closing an idle connection and,
 * unlike an SSE comment, reaches the page: lib/remote.ts uses it to show the feed as live and to notice
 * a connection that silently died.
 *
 * Bandwidth: hive images can be data URLs of up to 200 KB and hives are re-sent whenever their stats
 * change, so each connection remembers the image it last sent per hive and sends `image: ""` when it
 * is unchanged; the browser keeps the image it already has.
 *
 * With Supabase there is no in-process feed (browsers use Supabase Realtime): 204 No Content.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Keep in step with SSE_STALE_MS in lib/remote.ts (the browser gives up after ~2.5 missed pings). */
const HEARTBEAT_MS = 20_000;

export async function GET(req: Request) {
  const db = await getDb();
  if (db.kind === 'supabase') return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

  const enc = new TextEncoder();
  let close: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const sentImage = new Map<string, string>();
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          close(); // the consumer went away
        }
      };
      const onEvent = (ev: StreamEvent) => {
        let data: unknown;
        if (ev.type === 'hive') {
          const h = ev.hive;
          const digest = h.image ? createHash('sha1').update(h.image).digest('base64') : '';
          if (digest && sentImage.get(h.ca) === digest) data = { ...h, image: '' };
          else {
            sentImage.set(h.ca, digest);
            data = h;
          }
        } else data = ev.type === 'action' ? ev.action : ev.harvest;
        send(`event: ${ev.type}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const unsubscribe = db.subscribe(onEvent);
      const heartbeat = setInterval(() => send(`event: ping\ndata: ${Date.now()}\n\n`), HEARTBEAT_MS);

      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        req.signal.removeEventListener('abort', close);
        try {
          controller.close();
        } catch {
          // already closed / errored
        }
      };
      if (req.signal.aborted) return close();
      req.signal.addEventListener('abort', close);

      // the browser reconnects itself (with backoff); `retry` only matters for bare EventSource use
      send(`retry: 5000\n: connected ${Date.now()}\n\n`);
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: keeps compression middleware from buffering the stream
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
