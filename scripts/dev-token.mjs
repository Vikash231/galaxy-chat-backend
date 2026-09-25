// Local stand-in for Clerk: a dev RSA key signs Clerk-shaped session tokens so the API can be tested without a frontend.
//   node scripts/dev-token.mjs --init-env      write CLERK_JWT_KEY / FRONTEND_ORIGIN into .env (dev only)
//   node scripts/dev-token.mjs [user_id]       print a 1-hour token for that user (default user_dev)
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from "jose";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

const DIR = new URL("../.dev/", import.meta.url);
const ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3001";

if (!existsSync(new URL("private.pem", DIR))) {
  mkdirSync(DIR, { recursive: true });
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  writeFileSync(new URL("private.pem", DIR), await exportPKCS8(privateKey));
  writeFileSync(new URL("public.pem", DIR), await exportSPKI(publicKey));
}

if (process.argv[2] === "--init-env") {
  const envPath = new URL("../.env", import.meta.url);
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const pem = readFileSync(new URL("public.pem", DIR), "utf8").trim().replace(/\n/g, "\\n");
  const add = [];
  if (!/^CLERK_JWT_KEY=/m.test(env)) add.push(`CLERK_JWT_KEY="${pem}"`);
  if (!/^FRONTEND_ORIGIN=/m.test(env)) add.push(`FRONTEND_ORIGIN=${ORIGIN}`);
  if (add.length) appendFileSync(envPath, `\n# dev auth (scripts/dev-token.mjs); replace with real Clerk values\n${add.join("\n")}\n`);
  console.log(add.length ? `added ${add.length} line(s) to .env` : ".env already has dev auth values");
} else {
  const key = await importPKCS8(readFileSync(new URL("private.pem", DIR), "utf8"), "RS256");
  const token = await new SignJWT({ azp: ORIGIN, sid: "sess_dev" })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(process.argv[2] ?? "user_dev")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
  process.stdout.write(token);
}
