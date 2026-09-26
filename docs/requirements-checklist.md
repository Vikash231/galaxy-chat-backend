# Trial requirements checklist

Every requirement in the trial doc, checked against what is built. ✅ done and verified · ⚠️ partial · ❌ not built.
Last audited: 2026-09-25, end of Day 1.

## 1. Submission
| Requirement | Status | Notes |
|---|---|---|
| Two separate GitHub repos | ⚠️ | Both exist and are private; they still need sharing with the reviewers |
| Deployed app (Vercel) | ❌ | Needs Neon + Vercel accounts, a production Trigger.dev deploy, and a production Clerk URL |
| README: setup, architecture, decisions, improvements | ⚠️ | Backend README covers all four; the frontend README is minimal |
| Demo video (5 min) | ❌ | Day 3 |
| Working test credentials | ❌ | Create a test user after deploy |
| Mintlify docs URL | ❌ | Listed under submission requirements even though the section is marked "Bonus". The OpenAPI spec exists, so this is mostly setup |

## 2. Required stack
| Layer | Status | Notes |
|---|---|---|
| pnpm, Next.js App Router, TS strict, Postgres, Prisma, Clerk, REST route handlers | ✅ | |
| OpenRouter Free + provider-neutral tool loop | ✅ | Live-tested |
| Trigger.dev tasks + realtime metadata + typed streams | ✅ | Live-tested with curl; not yet seen in a browser |
| Zod, Zustand, TanStack Query, shadcn/ui, Tailwind | ✅ | |
| **Transloadit (Community) + S3-compatible storage** | ❌ | Waiting on the Transloadit and R2 accounts |
| Vitest + MSW | ⚠️ | 72 backend tests; **frontend has none** |
| React Testing Library | ❌ | |
| Playwright | ❌ | |
| Mintlify | ❌ | See §1 |

## 3. PostgreSQL requirements
| Requirement | Status | Notes |
|---|---|---|
| Prisma schema + committed migrations | ✅ | |
| Forward/rollback notes + compatibility assumptions | ❌ | |
| FKs for Chat, Message, AgentRun, ToolInvocation, CreditLedger | ✅ | |
| FKs for Attachment, RunSkill, Waitpoint | ✅ | All three tables exist with foreign keys |
| Cursor pagination, composite indexes, no unbounded scans | ✅ | |
| Transactions for message/run creation and settlement | ✅ | |
| Unique idempotency keys: dispatch, tool completion, charges | ✅ | |
| Unique idempotency keys: approvals | ✅ | `Waitpoint` is unique on `(runId, key)`; the token key is `waitpoint:<id>` |

## 4. Contract-driven frontend + backend
| Requirement | Status | Notes |
|---|---|---|
| Zod at every trust boundary | ⚠️ | Responses aren't parsed through their schemas before sending |
| Backend owns limits, eligibility, **model metadata** | ⚠️ | No model/status endpoint for the composer |
| Frontend uses generated types | ✅ | `openapi-typescript` |
| Centralized typed API module + TanStack Query | ✅ | |
| One registry drives discovery, validation, execution, cost estimate **and result rendering** | ⚠️ | Rendering is hard-coded in the frontend (`TOOL_LABELS`) instead of coming from the registry |

## 5. Skills system
| Requirement | Status |
|---|---|
| `agent-skills/<name>/SKILL.md` with frontmatter | ❌ |
| Registry: scan, validate, size limits, reject duplicates | ❌ |
| Names and descriptions in the base prompt; `load_skill` / `read_skill_asset` tools | ❌ |
| Path normalization, traversal protection | ❌ |
| `RunSkill` persistence with content hash; dedupe; restore on resume | ❌ |
| 3 skills + tests (selective load, bad frontmatter, duplicates, unknown, traversal, dedupe, resume) | ❌ |

## 6. Chat workspace (frontend)
| Requirement | Status | Notes |
|---|---|---|
| Shell: navigation, message list, pinned composer | ✅ | Not yet seen in a browser |
| **Artifact panel** | ❌ | |
| Composer: multiline, send, stop | ✅ | |
| Composer: **OpenRouter Free status, attachments, media picker**, plan mode, interrupt | ⚠️ | Attachments, plan-mode toggle and interrupt are built; the free-model status and media picker are not |
| Accessibility: keyboard, focus, screen-reader labels, error recovery | ⚠️ | Labels and keyboard sending done; no full pass yet |
| Responsive: mobile keeps the same controls | ❌ | The sidebar is hidden on mobile and there's no mobile navigation |
| Matches the reference product exactly | ❌ | Not started |

## 7. Messages & attachments
| Requirement | Status | Notes |
|---|---|---|
| Typed roles; success, failed, cancelled states | ✅ | |
| Chats and messages stored separately, cursor-paginated | ✅ | |
| Blocks: text, thinking, tool use, tool result | ✅ | |
| Blocks: **citations, usage** | ❌ | |
| Message-length limit | ✅ | |
| Attachment limits (count, MIME, size, URL, plan quota) | ❌ | |
| **Attachments via Transloadit + Uppy** (progress, cancel, retry, order) | ❌ | |
| Generated **image** persisted and rendered | ⚠️ | Rendered, but only Magica's URL is stored, not a copy in R2 |
| Generated **video / audio** rendered | ❌ | |
| Failed/cancelled turns visible | ✅ | |
| Failed/cancelled turns retryable | ✅ | `POST /runs/{id}/retry` and a Retry button on the newest reply |

## 8. Required tools (Magica)
| Requirement | Status | Notes |
|---|---|---|
| Crop Image | ✅ | Live-tested twice: percent and pixel modes, 5,000 microcredits each |
| **GPT Image 2** (text + edit) | ❌ | |
| **Merge Videos** | ❌ | |
| Agent chooses and **chains** tools | ⚠️ | Choosing works; chaining not built or tested |
| Model discovery: free route only, record the routed model, reject paid models | ✅ | |
| Durable UX: pending, running, completed, failed, cancelled, reload recovery | ✅ | |
| Durable UX: retry | ✅ | Retrying the turn re-runs its tool calls; blocked while a Magica job is still finishing |
| Acceptance: 1 success per tool + 1 chained conversation | ⚠️ | Crop only |
| Acceptance: invalid input, 401, 429, timeout, failed run, duplicate dispatch, persistence | ✅ | Tests |
| Acceptance: **reconnect** | ❌ | No test |

## 9. Execution engine
| Requirement | Status |
|---|---|
| Send: authenticate, validate, persist, one durable run | ✅ |
| Loop: restore context, OpenRouter, execute tools, continue until done | ✅ |
| Load skills on demand | ❌ |
| Durable Trigger.dev tasks; Magica work as child tasks | ✅ |
| Parallel tool calls with deterministic ordering and charges | ✅ |
| Preserve partial output on failure | ✅ |
| Text streamed separately from metadata, reconciled with the DB | ✅ |
| **Resume a crashed turn from its checkpoint** | ❌ |

## 10. Chat management
| Requirement | Status |
|---|---|
| Create, read, newest-first with cursors | ✅ |
| **Search** titles and message content | ❌ |
| **Pin/favourite** without breaking cursors | ❌ |
| **Delete** safely | ❌ |
| Ownership on every mutation | ✅ |

## 11. Realtime experience
| Requirement | Status | Notes |
|---|---|---|
| **Virtualized** message list | ❌ | Plain list |
| Stable pinned composer, no duplicate final message | ✅ | By design; not yet seen in a browser |
| Status model thinking → working → complete/failed/cancelled/stopping | ✅ | |
| Token-by-token text with current step | ✅ | |
| **Thinking duration, progress** | ❌ | |
| Tool detail: inputs, outputs, duration, credits, safe errors | ⚠️ | The live view shows duration and credits; saved messages show only status and input |
| Reconnect with bounded retries, token refresh, REST fallback | ⚠️ | Fallback and refresh are built; untested |
| Reload recovery | ⚠️ | Built; untested in a browser |

## 12. Credits
| Requirement | Status |
|---|---|
| Balance, ledger, per-tool cost, insufficient-credits block | ✅ |
| LLM usage recorded at 0 credits; tools charged exactly once | ✅ |
| **Total cost per assistant turn** | ❌ |
| **Refundable reservation at send** | ❌ (only a balance check) |

## 13. Error handling
| Scenario | Status |
|---|---|
| Model/tool timeout, terminal failure without a paid fallback | ✅ |
| All paths fail → failed turn with partial output kept | ✅ |
| Unauthorized access → non-leaking 404 | ✅ |
| Concurrent send → one active run | ✅ |
| **Recover stale locks** | ❌ |
| Message over limits → rejected before saving | ✅ |
| Attachment over limits | ❌ |
| Credits run out mid-turn → stop safely | ✅ |
| REST/realtime errors → backoff, token refresh, REST reconciliation | ⚠️ |
| Unanswered waitpoint → expire, clear overlay | ✅ |
| Every failure explainable from the UI (including a **retry path**) | ⚠️ |
| Structured logs with ids | ⚠️ (`processId` missing; `waitpointTokenId` is logged) |

## 14. Human waitpoints (approvals, plan mode)
| Requirement | Status |
|---|---|
| Options / plan / credit / media approval waitpoints | ✅ |
| Pause safely, resume exactly once, tolerate duplicate submits | ✅ |
| Approval overlays in the UI | ✅ |

## 15. Bonus
| Item | Status |
|---|---|
| Versioned public API with API-key auth, chat completions, Magica tool execution | ❌ |
| Run status + conversation reads | ✅ (Clerk-authenticated) |
| Signed outbound webhooks | ❌ |
| MCP server (optional) | ❌ |

## Totals
Of **106** checked items: **42 ✅**, **16 ⚠️**, **48 ❌** (counted from the tables above).
Largest missing groups: skills (6), uploads/attachments (8), approvals/waitpoints (4+), two Magica tools, deployment and submission items, frontend tests and fidelity.
