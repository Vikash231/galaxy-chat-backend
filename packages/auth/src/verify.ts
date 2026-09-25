import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AppError } from "@gx/contracts";

export type Principal = { clerkUserId: string; sessionId: string | null };

/** Keys to trust: Clerk's JWKS URL (production), a PEM public key (local dev tokens), or both outside production. */
export type VerifyOptions = { jwksUrl?: string; jwtKey?: string; authorizedParties: string[]; clockToleranceSec?: number };

const pemKeys = new Map<string, Promise<CryptoKey>>();
const pemKey = (pem: string) => {
  if (!pemKeys.has(pem)) pemKeys.set(pem, importSPKI(pem.replace(/\\n/g, "\n"), "RS256"));
  return pemKeys.get(pem)!;
};
// jose caches the fetched key set and refetches only on an unknown key id, so requests stay networkless.
const jwksSets = new Map<string, JWTVerifyGetKey>();
const jwks = (url: string) => {
  if (!jwksSets.has(url)) jwksSets.set(url, createRemoteJWKSet(new URL(url)));
  return jwksSets.get(url)!;
};

/**
 * Verify a Clerk session token without calling Clerk: RS256 signature with the instance public key,
 * time claims, and the authorized party (the frontend origin that minted it).
 */
export async function verifySessionToken(authorization: string | null, opts: VerifyOptions): Promise<Principal> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new AppError("unauthenticated", "Sign in to continue.");
  const check = { algorithms: ["RS256"], clockTolerance: opts.clockToleranceSec ?? 5 };
  const { jwksUrl, jwtKey } = opts;
  const verifiers = [
    ...(jwksUrl ? [(t: string) => jwtVerify(t, jwks(jwksUrl), check)] : []),
    ...(jwtKey ? [async (t: string) => jwtVerify(t, await pemKey(jwtKey), check)] : []),
  ];
  try {
    const payload = await firstValid(token, verifiers);
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("missing sub");
    if (payload.azp !== undefined && !opts.authorizedParties.includes(String(payload.azp))) throw new Error("azp not allowed");
    return { clerkUserId: payload.sub, sessionId: typeof payload.sid === "string" ? payload.sid : null };
  } catch {
    throw new AppError("unauthenticated", "Your session has expired. Sign in again.");
  }
}

async function firstValid(token: string, verifiers: ((t: string) => Promise<{ payload: Record<string, unknown> }>)[]) {
  let last: unknown = new Error("no verification key configured");
  for (const verify of verifiers) {
    try {
      return (await verify(token)).payload;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
