# Service: api (Next.js route handlers). Production deploys to Vercel; this image is for local compose and self-hosting.
FROM node:22-alpine AS base
RUN npm i -g pnpm@10.34.5
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @gx/db generate \
 && NEXT_TELEMETRY_DISABLED=1 pnpm --filter @gx/api build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 SERVICE_NAME=api PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/api/.next/standalone ./
COPY --from=build /repo/apps/api/.next/static ./apps/api/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/api/server.js"]
