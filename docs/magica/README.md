# Magica API reference snapshots

Responses captured with read-only calls (0 credits) on 2026-09-25. Each tool in `packages/tools` is written against these.

- `models.json`: `GET /v1/models`, every nodeType and its subModelIds
- `<id>.schema.json`: `GET /v1/models/{id}/schema`, the input fields a tool must map to
- `<id>.pricing.json`: `GET /v1/models/{id}/pricing`, the source of each tool's `estimateMicro`

The real output of a live crop run is in `packages/magica/src/fixtures/`.
