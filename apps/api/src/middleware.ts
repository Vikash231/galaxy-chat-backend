import { NextResponse, type NextRequest } from "next/server";

function corsHeaders(origin: string | null): Record<string, string> {
  // Read per request: on the Node runtime this is the deployed value, not a build-time snapshot.
  if (!origin || origin !== process.env.FRONTEND_ORIGIN) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-request-id",
    "access-control-expose-headers": "x-trace-id, retry-after",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

/** CORS for the single frontend origin, and a request id that every log line and error body carries. */
export function middleware(req: NextRequest) {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers: cors });

  const headers = new Headers(req.headers);
  if (!headers.get("x-request-id")) headers.set("x-request-id", crypto.randomUUID());
  const res = NextResponse.next({ request: { headers } });
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

export const config = { matcher: "/api/:path*", runtime: "nodejs" };
