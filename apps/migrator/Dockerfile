# Service: migrator. One-shot: applies committed migrations over the direct (non-pooled) connection.
FROM node:22-alpine
RUN npm i -g pnpm@10.34.5
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/db packages/db
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --filter @gx/db...
WORKDIR /repo/packages/db
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
