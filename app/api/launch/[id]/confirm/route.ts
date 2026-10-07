import { confirmLaunch, errorResponse, okJson, readJson } from '@/lib/server/launch';
import { clientIp } from '@/lib/server/ratelimit';
import { publicStatus } from '@/app/api/_lib/public';

/**
 * POST /api/launch/[id]/confirm — advance a launch as far as it can go: verify the payment (live,
 * body { signature }), upload metadata, create the coin, publish the hive. Idempotent and safe to
 * call again (Retry); a concurrent call just reports the current status.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await readJson(req);
    return okJson(publicStatus(await confirmLaunch(params.id, body, { ip: clientIp(req.headers) })));
  } catch (e) {
    return errorResponse(e);
  }
}
