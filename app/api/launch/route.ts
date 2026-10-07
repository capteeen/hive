import { errorResponse, okJson, prepareLaunch, readJson } from '@/lib/server/launch';
import { clientIp } from '@/lib/server/ratelimit';

/**
 * POST /api/launch — prepare a launch: validate, check the owner's signature (live), reserve a cell,
 * create the queen + mint keys and quote the payment. Body: LaunchPrepareRequest.
 * Errors: { error, reasons? } with 400 (invalid), 429 (rate limited), 503 (live mode not configured / no cell).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    return okJson(await prepareLaunch(body, { ip: clientIp(req.headers) }));
  } catch (e) {
    return errorResponse(e);
  }
}
