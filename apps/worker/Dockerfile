# Service: worker (Trigger.dev tasks). Production uses `trigger deploy`, which builds its own image.
# This image runs the worker in dev mode against Trigger.dev cloud for local compose (needs TRIGGER_ACCESS_TOKEN).
FROM node:22-alpine
RUN npm i -g pnpm@10.34.5
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @gx/db generate
ENV SERVICE_NAME=worker
WORKDIR /repo/apps/worker
CMD ["pnpm", "exec", "trigger", "dev"]
