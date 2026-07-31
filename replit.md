# Nexus

A self-hosted, agentic AI workspace — chat plus tools, MCP servers, skills, retrieval over the user's own documents, long-term memory, multi-agent runs and browser control. Users run it themselves and point it at Cloudflare Workers AI (and other providers) with their own API keys. Every model call goes through the backend; the browser never sees a key.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (managed workflow provides PORT)
- `pnpm --filter @workspace/nexus run dev` — run the web app (managed workflow provides PORT + BASE_PATH)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run test` — deployment-topology e2e (needs a build first)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required env: `DATABASE_URL` (runtime-managed), `SESSION_SECRET`; recommended: `ENCRYPTION_KEY`
- Optional env: `AUTH_MODE` (`replit`|`local`), `ISSUER_URL`, `WEB_ORIGIN`, `STORAGE_DIR`, `MAX_UPLOAD_BYTES`, `FFMPEG_PATH`, `FFPROBE_PATH`, `BROWSER_WS_ENDPOINT`, `BROWSER_CDP_URL`, `MCP_ALLOW_STDIO`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind + shadcn/ui + wouter (`artifacts/nexus`)
- API: Express 5 (`artifacts/api-server`)
- DB: PostgreSQL + Drizzle ORM, pgvector when available
- Validation: Zod v4 (`zod` catalog is pinned to ^4 — Orval 8 generates v4-only APIs; do not downgrade)
- API codegen: Orval, for the auth + provider endpoints only
- Build: esbuild (api-server), Vite (web)

## Where things live

### Frontend (`artifacts/nexus/src/`)
- `lib/api.ts` — typed client. `api.get/post/put/patch/delete/upload`, `streamSse` (POST → SSE), `subscribeSse` (GET → SSE), `apiUrl`/`fileUrl`/`screenshotUrl`
- `lib/queries.ts` — React Query hooks for every endpoint, plus the `keys` registry mutations invalidate against
- `lib/types.ts` — wire types mirroring the server
- `lib/theme-provider.tsx` — theme/accent/font-size/density; sets CSS vars on `<html>`
- `hooks/use-chat-stream.ts` — the streaming turn state machine, including the tool-approval pause
- `pages/` — `chat`, `library`, `agents`, `browser`, `settings`
- `components/chat/` — model picker, message item, composer, sources panel, tool approval
- `components/output/` — markdown, chart, mermaid, artifact panel
- `components/settings/` — one tab per area (providers, models, tools, mcp, skills, keys, memory, appearance, data, about)
- `components/app-shell.tsx`, `conversation-sidebar.tsx`, `command-palette.tsx`

### API (`artifacts/api-server/src/`)
- `lib/ai/` — **the provider abstraction layer.** `streamChat`/`completeChat`/`completeJson`, `embed`, `transcribe`, `generateImage`, `speak`, `rerank`; `catalogue.ts` (live discovery), `defaults.ts` (`resolveModelForTask`), `usage.ts`
- `lib/chatEngine.ts` — one chat turn: context assembly → stream → tools → persist. Plus `resumeTurn` for approvals
- `lib/tools/` — `types.ts` (the contract), `builtin.ts` (19 tools), `registry.ts` (`executeTool`, `toolCatalogue`)
- `lib/permissions.ts` — `authorizeTool` and the audit log
- `lib/mcp/` — `client.ts` (http/sse/stdio transports), `index.ts` (CRUD, pooling, discovery, tool adaptation)
- `lib/agents/` — `loop.ts` (one worker), `index.ts` (planning, parallel dispatch, to-do mutations)
- `lib/rag/` — `chunk.ts`, `index.ts` (`retrieve`, `embedChunks`, `toCitations`)
- `lib/memory.ts` — summaries, semantic recall, durable facts, `assembleContext`
- `lib/ingest/` — `zip.ts` (dependency-free ZIP reader), `office.ts`, `pdf.ts`, `media.ts` (ffmpeg), `index.ts` (the pipeline)
- `lib/browser/` — `guard.ts` (SSRF), `html.ts` (HTML→markdown), `cdp.ts` (DevTools client), `search.ts`
- `lib/events.ts` — in-process pub/sub with replay, for SSE progress; also the cancellation registry
- `lib/secrets.ts`, `lib/storage.ts`, `lib/skills.ts`
- `routes/` — one router per area, all registered in `routes/index.ts`. `routes/helpers.ts` has `openSse` and the shared error shape

### Shared
- `lib/db/src/schema/` — `auth.ts`, `nexus.ts` (chat/files/memory/usage), `agentic.ts` (secrets/mcp/tools/skills/agents)
- `lib/db/src/vectors.ts` — the vector repository with its two drivers
- `lib/api-spec/openapi.yaml` — auth + provider endpoints only

## Architecture decisions

- **Portable auth**: `AUTH_MODE` selects Replit OIDC or local email+password; one `authMiddleware` gates all API routes either way.
- **Provider abstraction**: six capabilities behind one interface. Providers differ only in `ai/endpoints.ts` (where the call goes) and one of three wire-format families in `ai/chat.ts` (`openai-compat` | `anthropic` | `google`). Adding a provider = one endpoint entry, at most one adapter branch.
- **Model refs are `<provider>:<model>`** everywhere, so routing is never ambiguous.
- **Encrypted credentials**: provider keys and vault secrets are AES-256-GCM at rest and write-only over the API.
- **Deny-by-ask tools**: read-only tools auto-allow, `autoApprove` covers safe workspace-local writes (saving a memory, drafting an artifact), everything else asks. A background agent can't be prompted, so unauthorized tools are refused with an explanation instead of deadlocking.
- **Two SSE shapes**: chat streams on the request that started it (short-lived, cancellable). Agent runs publish to `lib/events.ts` and clients subscribe separately — that's what lets a run outlive the request and survive a reload.
- **Agent state in Postgres**: no Redis, no queue. Runs are resumable by re-calling `executeRun`, which picks up whatever is still pending.
- **Vectors behind a repository**: pgvector probed once at boot, JSON + in-process cosine as the portable fallback. Callers never branch on the driver.
- **MCP transport choice**: Streamable HTTP is the default because it works on request-scoped hosts. stdio is gated behind `MCP_ALLOW_STDIO` since it spawns processes and can't work on serverless anyway.
- **Browser behind one interface**: `fetch` driver always available (read-only), CDP driver when configured (full control). Results always report which driver served them.
- **Dependency-light ingestion**: one hand-rolled ZIP reader covers DOCX/XLSX/PPTX/EPUB/archives; HTML→markdown is hand-rolled too. Only `pdfjs-dist` was worth a dependency, and it's dynamically imported so a missing build disables PDF ingestion rather than breaking boot.
- **Host-agnostic**: every platform-specific service sits behind an env-selected driver.

## Product

Milestone 1 (auth, schema, encrypted provider keys with live connection testing) plus milestones 2–10 are complete: model catalogue, streaming chat, file ingestion, RAG with citations, media handling, memory, rich output, gateway routing, usage tracking, export/import and polish. The Books milestone was explicitly dropped by the user.

Built on top of the original spec: MCP client and management UI, a general secret vault, skills (authored and generated), a tool permission model with audit, multi-agent orchestration with an editable to-do list, and browser control.

## User preferences

- Hosting is undecided (Replit / Cloudflare / Weblet / own computer) — keep the app host-agnostic; never hard-code Replit-only services.
- Cloudflare Workers AI is the primary model source; also support OpenRouter and direct providers behind the same abstraction.
- Verify Cloudflare endpoint shapes against developers.cloudflare.com docs when building provider features.
- No Books feature.

## Gotchas

- Zod catalog must stay v4 (`^4.x`) — Orval emits `z.email()`/`z.url()`/`z.int()`; zod 3 breaks the libs typecheck.
- New endpoints use the hand-written client in `artifacts/nexus/src/lib/api.ts`, **not** Orval. Only auth and providers are in `openapi.yaml`; re-run codegen after changing that file.
- Any provider adapter or tool that fetches a user-controlled URL must pass it through `assertPublicHttpUrl` (providers) or `assertPublicWebUrl`/`guardedFetch` (web/browser), and must not follow redirects blindly.
- `lib/tools/builtin.ts` imports the agent orchestrator lazily (`await import('../agents')`) — the orchestrator imports the registry, so a static import would be circular.
- `pdfjs-dist` is in `build.mjs`'s `external` list. Bundling it breaks its internal asset paths.
- `searchVectors` builds raw SQL. Only server-constructed predicates go in — never user text.
- New composite libs need `composite`/`declarationMap`/`emitDeclarationOnly` in tsconfig and a root `tsconfig.json` reference.
- Reverse proxies must disable buffering on `/api` or SSE streaming arrives as one delayed blob (`proxy_buffering off`).
- Self-hosted deployments: same-origin reverse proxy for `/api`, or split-origin with `WEB_ORIGIN` (API) + `VITE_API_URL` (web build); dev off-Replit uses `API_PROXY_TARGET` for the Vite proxy.
- `uploads/` is gitignored. Override the location with `STORAGE_DIR`.

## Verification status

Verified on a Windows dev machine:
- `pnpm run typecheck` passes across all packages.
- The api-server bundle builds and boots; `/api/healthz` returns 200, all 14 new route groups return 401 unauthenticated, and a cookie-authenticated mutation from a foreign Origin returns 403.

**Not yet verified — do this first on Replit:** every database query is typechecked but has never executed, because no Postgres was reachable on the dev machine. Run `pnpm --filter @workspace/db run push`, then `pnpm run build`, then `pnpm --filter @workspace/api-server run test`. The web bundle also hasn't been built (Vite needs rollup's Linux-only native binary, which this workspace pins deliberately).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
