# Galaxy Agent Chat: backend

This is the backend for an agent chat. A user sends a message. A durable [Trigger.dev](https://trigger.dev) task then streams a reply from OpenRouter's free models and calls Magica media tools. Postgres records every step, so a reload or disconnect never loses anything.

Design, flow diagrams and API lifecycles are in [`docs/architecture.html`](docs/architecture.html) (low-level design: [`docs/day1-lld.md`](docs/day1-lld.md)). The published page is https://claude.ai/artifact/VULrUR8zgQuptJWYwWpKTr.

## Services

| Service | Folder | Deploys to | Job |
|---|---|---|---|
| api | `apps/api` | Vercel | Auth, validation, chat and message reads, admitting and dispatching a turn, run status, cancel, realtime tokens, OpenAPI |
| worker | `apps/worker` | Trigger.dev cloud | `agent-turn` (queue `agent-turns`): the agent loop. `magica-run` (queue `tool-runs`): one provider call |
| migrator | `apps/migrator` | CI / one-shot | `prisma migrate deploy` |

Shared code lives in `packages/*`: `config`, `contracts`, `db`, `auth`, `observability`, `llm`, `magica`, `tools`, `agent`. Apps depend on packages, never the reverse.

## Local setup

```bash
pnpm install                      # pnpm 10 (pinned via packageManager)
cp .env.example .env              # fill in the keys you have
pnpm db:up                        # Postgres 16 on localhost:5433
pnpm db:migrate                   # apply migrations
pnpm test                         # 69 tests; needs the galaxy_test database (below)
pnpm dev:api                      # http://localhost:3000/api/health
pnpm dev:worker                   # trigger dev (needs TRIGGER_PROJECT_REF + `npx trigger.dev login`)
```

Test database, created once:

```bash
docker exec galaxy-chat-postgres-1 psql -U galaxy -c "CREATE DATABASE galaxy_test"
cd packages/db && DATABASE_URL=postgresql://galaxy:galaxy@localhost:5433/galaxy_test \
  DIRECT_URL=postgresql://galaxy:galaxy@localhost:5433/galaxy_test npx prisma migrate deploy
```

Full stack in containers: `docker compose -f docker/docker-compose.yml --profile full up --build`.

## Testing every API

```bash
node scripts/dev-token.mjs --init-env   # dev stand-in for Clerk: writes CLERK_JWT_KEY + FRONTEND_ORIGIN to .env
pnpm dev:api                            # terminal 1
scripts/smoke.sh                        # terminal 2: calls all 11 endpoints, prints PASS/FAIL
```

Without `TRIGGER_SECRET_KEY`, sending a message returns `503 dispatch_failed` (expected). Add the Trigger.dev and OpenRouter keys, then run `pnpm dev:worker` in a third terminal; the smoke script then waits for the run and prints the reply and tool results. For a single request: `curl -H "Authorization: Bearer $(node scripts/dev-token.mjs)" localhost:3000/api/v1/me`.

## Credit safety

- `MAGICA_MODE=fixture` (the default) never calls Magica. Tests always run against MSW mocks.
- In `live` mode, every dispatch first reserves its estimated cost against `MAGICA_DAILY_CAP_MICRO` in one conditional `UPDATE`, so parallel calls can't exceed the cap.
- A tool call is sent to Magica at most once. If the worker crashes between sending the request and saving the Magica run ID, the call fails as `dispatch_uncertain` rather than being sent again.

## Decisions and trade-offs

- **Our own agent loop, no framework.** Each step is saved before the next begins, and every tool call has a unique `(runId, toolCallId)` row, so retries never repeat paid work. Frameworks hide those step boundaries.
- **The Magica webhook points at the Trigger.dev token URL.** The worker sleeps without using compute and wakes when Magica finishes. The webhook body is ignored and the result is always re-read with `GET`, so we need no webhook route or signing secret.
- **Duplicate protection is in the database.** A partial unique index allows one active run per chat. `clientMessageId` makes a double-submit return the same turn. The ledger's `tool:<id>` key charges each tool once.
- **`agent-turn` runs once (no automatic retry).** Retrying blindly would call the model again and could start new paid tool calls. A failed turn keeps its saved partial output and can be retried by the user.

## What's next

GPT Image 2 and Merge Videos (one file each in `packages/tools`), skills, Transloadit uploads, approval waitpoints, search and pinning, resuming a crashed turn from its last checkpoint, outbound webhooks, and Mintlify docs generated from `/api/openapi.json`.
