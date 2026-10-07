import { errorResponse, okJson, readJson, refundLaunch } from '@/lib/server/launch';
import { clientIp } from '@/lib/server/ratelimit';

/**
 * POST /api/launch/[id]/refund — return the queen wallet's SOL to the owner for a failed launch
 * (or an expired one whose payment arrived). Body { signature }: the owner's signature over
 * `HIVE refund <id>` (required in live mode).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await readJson(req);
    return okJson(await refundLaunch(params.id, body, { ip: clientIp(req.headers) }));
  } catch (e) {
    return errorResponse(e);
  }
}
