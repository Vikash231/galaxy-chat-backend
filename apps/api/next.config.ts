import type { NextConfig } from "next";

const config: NextConfig = {
  // `next dev` and `next build` write to separate folders so a build never breaks a running dev server.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  output: "standalone",
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  transpilePackages: ["@gx/auth", "@gx/config", "@gx/contracts", "@gx/db", "@gx/observability"],
  serverExternalPackages: ["@prisma/client", "pino"],
  // pnpm hides the generated Prisma engine from Next's file tracing; ship it explicitly.
  outputFileTracingIncludes: { "/**": ["../../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/**/*"] },
};

export default config;
