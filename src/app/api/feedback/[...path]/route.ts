/* /api/feedback: in-app reports. Everything is in src/lib/feedback/handler.ts. */
import { handleFeedback } from '@/lib/feedback/handler';
import { withRequestId } from '@/lib/requestId';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handle = withRequestId<{ params: Promise<{ path: string[] }> }>(async (req, ctx) => handleFeedback(req, (await ctx.params).path));
export const GET = handle, HEAD = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle;
