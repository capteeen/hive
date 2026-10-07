import { NextResponse } from 'next/server';
import { publicConfig } from '@/lib/server/config';

/** GET /api/config: what the browser needs to know about this server (no secrets). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(publicConfig(), { headers: { 'Cache-Control': 'no-store' } });
}
