import { importSPKI, jwtVerify } from "jose";
import { AppError } from "@gx/contracts";

export type Principal = { clerkUserId: string; sessionId: string | null };

export type VerifyOptions = { jwtKey: string; authorizedParties: string[]; clockToleranceSec?: number };

const keys = new Map<string, Promise<CryptoKey>>();
const keyFor = (pem: string) => {
  if (!keys.has(pem)) keys.set(pem, importSPKI(pem.replace(/\\n/g, "\n"), "RS256"));
  return keys.get(pem)!;
};

/**
 * Verify a Clerk session token without calling Clerk: RS256 signature with the instance public key,
 * time claims, and the authorized party (the frontend origin that minted it).
 */
export async function verifySessionToken(authorization: string | null, opts: VerifyOptions): Promise<Principal> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new AppError("unauthenticated", "Sign in to continue.");
  try {
    const { payload } = await jwtVerify(token, await keyFor(opts.jwtKey), {
      algorithms: ["RS256"],
      clockTolerance: opts.clockToleranceSec ?? 5,
    });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("missing sub");
    if (payload.azp !== undefined && !opts.authorizedParties.includes(String(payload.azp))) throw new Error("azp not allowed");
    return { clerkUserId: payload.sub, sessionId: typeof payload.sid === "string" ? payload.sid : null };
  } catch {
    throw new AppError("unauthenticated", "Your session has expired. Sign in again.");
  }
}
