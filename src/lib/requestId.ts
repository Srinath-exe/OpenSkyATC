/* x-request-id on every API answer, and in the log line of every call that failed: a report's failed call leads to it. */
type Handler<C> = (req: Request, ctx: C) => Promise<Response> | Response;

export function withRequestId<C = unknown>(handler: Handler<C>) {
  return async (req: Request, ctx?: C): Promise<Response> => {
    const id = crypto.randomUUID();
    let res: Response;
    try { res = await handler(req, ctx as C); } catch (e) {
      console.error(`[api ${id}] ${req.method} ${new URL(req.url).pathname} threw`, e);
      res = new Response(JSON.stringify({ error: 'server error' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    if (res.status >= 400) console.warn(`[api ${id}] ${req.method} ${new URL(req.url).pathname} ${res.status}`);
    try { res.headers.set('x-request-id', id); return res; } catch {
      const h = new Headers(res.headers); h.set('x-request-id', id);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
  };
}
