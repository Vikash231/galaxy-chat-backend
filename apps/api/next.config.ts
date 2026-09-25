import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  transpilePackages: ["@gx/auth", "@gx/config", "@gx/contracts", "@gx/db", "@gx/observability"],
  serverExternalPackages: ["@prisma/client", "pino"],
  // pnpm hides the generated Prisma engine from Next's file tracing; ship it explicitly.
  outputFileTracingIncludes: { "/**": ["../../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/**/*"] },
};

export default config;
