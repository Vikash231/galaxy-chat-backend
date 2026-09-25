import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { verifySessionToken } from "@gx/auth";
import { apiEnv } from "@gx/config";
import { AppError, httpStatus } from "@gx/contracts";
import { ensureUser, type UserRow } from "@gx/db";
import { logger, withContext, type Logger } from "@gx/observability";

type Schema = z.ZodType;
type Out<S> = S extends z.ZodType ? z.infer<S> : undefined;

export type RouteSpec<P, Q, B> = { params?: P; query?: Q; body?: B; auth?: boolean };
export type RouteCtx<P, Q, B, A extends boolean> = {
  req: NextRequest;
  params: Out<P>;
  query: Out<Q>;
  body: Out<B>;
  user: A extends false ? null : UserRow;
  log: Logger;
  traceId: string;
};
export type Reply = { status?: number; data: unknown };

/**
 * The one pipeline every route goes through: trace id → auth → provisioning → zod → handler → error envelope.
 * Handlers only ever see validated input and an authenticated user.
 */
export function withRoute<P extends Schema | undefined = undefined, Q extends Schema | undefined = undefined, B extends Schema | undefined = undefined, A extends boolean = true>(
  spec: RouteSpec<P, Q, B> & { auth?: A },
  handler: (ctx: RouteCtx<P, Q, B, A>) => Promise<Reply>,
) {
  return async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
    const traceId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    let log = withContext({ traceId }, logger);
    try {
      let user: UserRow | null = null;
      if (spec.auth !== false) {
        const env = apiEnv();
        const principal = await verifySessionToken(req.headers.get("authorization"), {
          jwksUrl: env.CLERK_JWKS_URL,
          jwtKey: env.CLERK_JWT_KEY,
          authorizedParties: [env.FRONTEND_ORIGIN],
        });
        user = await ensureUser(principal.clerkUserId, env.NEW_USER_GRANT_MICRO);
        log = withContext({ userId: user.id }, log);
      }
      const params = spec.params ? spec.params.parse(await ctx.params) : undefined;
      const query = spec.query ? spec.query.parse(Object.fromEntries(req.nextUrl.searchParams)) : undefined;
      const body = spec.body ? spec.body.parse(await req.json().catch(() => ({}))) : undefined;

      const reply = await handler({ req, params, query, body, user, log, traceId } as RouteCtx<P, Q, B, A>);
      return NextResponse.json(reply.data, { status: reply.status ?? 200, headers: { "x-trace-id": traceId } });
    } catch (e) {
      return errorResponse(e, traceId, log);
    }
  };
}

function errorResponse(e: unknown, traceId: string, log: Logger) {
  const headers = { "x-trace-id": traceId };
  if (e instanceof AppError) {
    if (e.code === "rate_limited") Object.assign(headers, { "retry-after": "60" });
    log.info({ code: e.code }, "request.rejected");
    return NextResponse.json({ error: { code: e.code, message: e.message, traceId, ...(e.details && { details: e.details }) } }, { status: httpStatus[e.code], headers });
  }
  if (e instanceof z.ZodError) {
    const issues = e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return NextResponse.json({ error: { code: "validation_failed", message: "Some fields are invalid.", traceId, details: { issues } } }, { status: 422, headers });
  }
  log.error({ err: e }, "request.failed");
  return NextResponse.json({ error: { code: "internal", message: "Something went wrong. Try again.", traceId } }, { status: 500, headers });
}
