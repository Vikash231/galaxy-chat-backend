import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, exportSPKI, generateKeyPair } from "jose";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { verifySessionToken } from "./verify";

let privateKey: CryptoKey;
let jwtKey: string;
let otherKey: CryptoKey;
const ORIGIN = "http://localhost:3001";

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey;
  jwtKey = await exportSPKI(kp.publicKey);
  otherKey = (await generateKeyPair("RS256")).privateKey;
});

const token = (claims: Record<string, unknown> = {}, key = privateKey, exp = "60s") =>
  new SignJWT({ azp: ORIGIN, sid: "sess_1", ...claims }).setProtectedHeader({ alg: "RS256" }).setSubject("user_1").setIssuedAt().setExpirationTime(exp).sign(key);

const verify = (auth: string | null) => verifySessionToken(auth, { jwtKey, authorizedParties: [ORIGIN] });

describe("verifySessionToken", () => {
  it("accepts a valid Clerk-style token", async () => {
    await expect(verify(`Bearer ${await token()}`)).resolves.toEqual({ clerkUserId: "user_1", sessionId: "sess_1" });
  });

  it.each([
    ["missing header", async () => null],
    ["expired", async () => `Bearer ${await token({}, privateKey, "-10s")}`],
    ["wrong signing key", async () => `Bearer ${await token({}, otherKey)}`],
    ["other origin", async () => `Bearer ${await token({ azp: "https://evil.example" })}`],
    ["not a bearer token", async () => "Basic abc"],
  ])("rejects %s with 401", async (_name, header) => {
    await expect(verify(await header())).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("verifySessionToken with Clerk's JWKS URL", () => {
  const JWKS_URL = "https://clerk.example.dev/.well-known/jwks.json";
  const server = setupServer();
  let jwksKey: CryptoKey;

  beforeAll(async () => {
    const kp = await generateKeyPair("RS256", { extractable: true });
    jwksKey = kp.privateKey;
    const jwk = { ...(await exportJWK(kp.publicKey)), kid: "ins_1", alg: "RS256", use: "sig" };
    server.use(http.get(JWKS_URL, () => HttpResponse.json({ keys: [jwk] })));
    server.listen({ onUnhandledRequest: "error" });
  });
  afterAll(() => server.close());

  const signed = (key: CryptoKey) =>
    new SignJWT({ azp: ORIGIN, sid: "sess_2" }).setProtectedHeader({ alg: "RS256", kid: "ins_1" }).setSubject("user_2").setIssuedAt().setExpirationTime("60s").sign(key);

  it("accepts a token signed by a key in the JWKS", async () => {
    await expect(verifySessionToken(`Bearer ${await signed(jwksKey)}`, { jwksUrl: JWKS_URL, authorizedParties: [ORIGIN] })).resolves.toMatchObject({ clerkUserId: "user_2" });
  });

  it("still accepts local dev tokens when a dev key is also configured", async () => {
    await expect(verifySessionToken(`Bearer ${await token()}`, { jwksUrl: JWKS_URL, jwtKey, authorizedParties: [ORIGIN] })).resolves.toMatchObject({ clerkUserId: "user_1" });
  });

  it("rejects a token signed by an unknown key", async () => {
    await expect(verifySessionToken(`Bearer ${await signed(otherKey)}`, { jwksUrl: JWKS_URL, authorizedParties: [ORIGIN] })).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
