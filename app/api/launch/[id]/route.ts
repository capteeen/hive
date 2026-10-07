import { errorResponse, launchStatus, okJson } from '@/lib/server/launch';
import { clientIp } from '@/lib/server/ratelimit';
import { publicStatus } from '@/app/api/_lib/public';

/** GET /api/launch/[id] — LaunchStatusResponse (the hive too once live). Never includes secrets. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    return okJson(publicStatus(await launchStatus(params.id, { ip: clientIp(req.headers) })));
  } catch (e) {
    return errorResponse(e);
  }
}
