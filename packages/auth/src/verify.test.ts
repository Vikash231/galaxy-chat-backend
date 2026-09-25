import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
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
