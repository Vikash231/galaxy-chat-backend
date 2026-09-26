import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

vi.stubEnv("FRONTEND_ORIGIN", "http://localhost:3001");
const { middleware } = await import("./middleware");

const preflight = (origin: string, method: string) =>
  middleware(new NextRequest("http://localhost:3000/api/v1/chats/abc", { method: "OPTIONS", headers: { origin, "access-control-request-method": method } }));

describe("CORS preflight", () => {
  // Every method the API routes accept must be allowed, or the browser blocks the call before it is sent.
  it.each(["GET", "POST", "PATCH", "DELETE"])("allows %s from the frontend origin", (method) => {
    const res = preflight("http://localhost:3001", method);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3001");
    expect(res.headers.get("access-control-allow-methods")?.split(/,\s*/)).toContain(method);
  });

  it("gives no CORS headers to another origin", () => {
    const res = preflight("https://evil.example", "DELETE");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

/** Every HTTP method any route file exports (GET, POST, PATCH, DELETE...). */
function routeMethods(dir: string): Set<string> {
  const found = new Set<string>();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) routeMethods(path).forEach((m) => found.add(m));
    else if (name === "route.ts") for (const m of readFileSync(path, "utf8").matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)) found.add(m[1]!);
  }
  return found;
}

describe("route methods", () => {
  it("every method a route exports is allowed by CORS, so the browser never blocks it", () => {
    const methods = routeMethods(join(__dirname, "app/api"));
    expect(methods.size).toBeGreaterThan(0);
    const allowed = preflight("http://localhost:3001", "GET").headers.get("access-control-allow-methods")?.split(/,\s*/) ?? [];
    for (const m of methods) expect(allowed, `CORS must allow ${m}`).toContain(m);
  });
});
