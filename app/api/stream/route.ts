import { getDb } from '@/lib/server/db';
import { publicConfig } from '@/lib/server/config';
import { clientIp } from '@/lib/server/ratelimit';
import { MAX_QUEUED_BYTES, acquireSlot, hubFor, type StreamClient } from '@/app/api/_lib/stream-hub';

/**
 * GET /api/stream: Server-Sent Events from the store's change feed.
 *   event: hive | action | harvest
 *   data:  the RemoteHive / RemoteAction / RemoteHarvest as JSON
 * plus `event: ping` (data: server ms) every 20s. It keeps proxies from closing an idle connection and,
 * unlike an SSE comment, reaches the page: lib/remote.ts uses it to show the feed as live and to notice
 * a connection that silently died.
 *
 * Hive images are never inlined: `image` is the `/api/hives/<ca>/image?v=…` path (see app/api/_lib/public.ts).
 * Every event is encoded once per process and shared by all connections (app/api/_lib/stream-hub.ts).
 *
 * Limits: MAX_CONNECTIONS per process (503 beyond) and MAX_PER_IP per identifiable client (429). A
 * connection whose unread queue passes MAX_QUEUED_BYTES is dropped; the browser reconnects and re-fetches
 * the list, so a slow reader loses nothing but never makes the server buffer for it.
 *
 * Supabase: browsers normally use Supabase Realtime and this answers 204. Without an anon key the
 * browser is told to use SSE (publicConfig), so this serves the feed from polling the database.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const db = await getDb();
  if (db.kind === 'supabase' && publicConfig().realtime === 'supabase') return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  const hub = hubFor(db, db.kind === 'supabase' ? 'poll' : 'events');

  const slot = acquireSlot(clientIp(req.headers));
  if (!slot.ok) {
    return new Response(slot.status === 429 ? 'Too many open feeds from this address.' : 'The live feed is full. Try again shortly.', {
      status: slot.status,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '30', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const enc = new TextEncoder();
  let close: () => void = slot.release;

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        const client: StreamClient = {
          push(bytes) {
            if (closed) return;
            // desiredSize = MAX_QUEUED_BYTES minus what is queued and unread: a stalled socket stops the
            // reads, so this is where a slow client shows. Drop it (discarding its queue) rather than buffer.
            // An empty queue always takes the next event, however large.
            const room = controller.desiredSize;
            if (room !== null && room < MAX_QUEUED_BYTES && room < bytes.byteLength) return drop(new Error('SSE client is not reading; dropped.'));
            try {
              controller.enqueue(bytes);
            } catch {
              close(); // the consumer went away
            }
          },
        };
        const finish = () => {
          if (closed) return false;
          closed = true;
          hub.remove(client);
          slot.release();
          req.signal.removeEventListener('abort', close);
          return true;
        };
        const drop = (e: Error) => {
          if (!finish()) return;
          try {
            controller.error(e); // frees the queued chunks now
          } catch {
            // already closed / errored
          }
        };
        close = () => {
          if (!finish()) return;
          try {
            controller.close();
          } catch {
            // already closed / errored
          }
        };
        if (req.signal.aborted) return close();
        req.signal.addEventListener('abort', close);

        // the browser reconnects itself (with backoff); `retry` only matters for bare EventSource use
        controller.enqueue(enc.encode(`retry: 5000\n: connected ${Date.now()}\n\n`));
        hub.add(client);
      },
      cancel() {
        close();
      },
    },
    { highWaterMark: MAX_QUEUED_BYTES, size: (chunk) => chunk.byteLength },
  );

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
