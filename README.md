# Nexus

A self-hosted AI chat workspace — a cleaner, more capable alternative to the ChatGPT web UI that you run yourself and point at Cloudflare Workers AI (plus OpenRouter, OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, xAI, or any OpenAI-compatible endpoint) using your own API keys. The browser never sees a key: every model call goes through the backend.

Beyond chat, Nexus is an agentic workspace — tools, MCP servers, skills, a permission model, retrieval over your own documents, long-term memory, multi-agent runs, and browser control.

## What it does

**Chat**
- Token-by-token streaming over SSE with a stop button
- Conversation sidebar: search across titles *and* message bodies, date grouping, folders, pin, archive, rename, delete, export as Markdown or JSON
- Per-message actions: copy, regenerate, edit-and-resend, branch from here, thumbs up/down, read aloud, plus token counts and latency
- Composer: auto-growing input, drag-and-drop, paste-image, attachment chips, mic button that records and transcribes, sampling sliders, and toggles for library retrieval and tool use
- Model picker grouped by provider and task, showing context window and modality badges

**Tools, MCP and permissions**
- 19 built-in tools across web, browser, library, memory, media, rich output and agent coordination
- MCP servers over Streamable HTTP and legacy SSE (stdio too, on a long-lived host) — their tools appear alongside the built-ins
- Deny-by-ask authorization. Read-only tools run freely; anything that writes, spends provider credit, or reaches an external system asks first, and "always allow" writes a real permission
- Every tool call is audited, with credential-looking arguments redacted before they're stored

**Skills**
- Reusable instruction blocks with their own tool allowlist and optional model binding
- Attach one per conversation, or let keyword matching pick it automatically
- Generate a skill from a plain-language description — wired only to tools that exist on your install

**Library and retrieval**
- Upload PDF, DOCX, XLSX, PPTX, EPUB, text, code, CSV, images, audio, video and zip archives
- Async ingestion with visible status: queued → extracting → chunking → embedding → ready, or failed with a reason you can act on
- Retrieval is vector search over ~800-token chunks (15% overlap, never crossing a page or chapter boundary), reranked from 20 candidates down to 5, injected with citation metadata
- Sources panel shows file, page or timestamp, and similarity score, and jumps to the passage
- Viewers per type, each with "Ask about this" to open a chat scoped to that document

**Memory**
- Rolling summaries once a thread outgrows its context window, with an expandable marker in the chat
- Semantic recall of relevant older messages from this and other threads, labelled as recalled context
- Durable facts extracted after each exchange, deduped and superseded rather than piled up — all viewable, editable and deletable

**Agents**
- A planner splits a goal into a dependency-aware task tree; independent tasks run in parallel
- Run state lives in Postgres, so a restart or a page reload doesn't lose progress
- The to-do list is a real object: add tasks, retry a failure, skip, reorder, or undo a completed task (which also resets everything downstream of it)
- Live progress over SSE with replay, so opening the panel late still shows what happened

**Browser and web**
- SSRF-guarded fetch with readable extraction, and keyless web search that upgrades automatically if you store a Brave, Tavily or Serper key
- Real browser control (navigate, click, type, scroll, screenshot, evaluate) when a CDP endpoint is configured
- A Web panel to drive any of it yourself, not just through the model

**Rich output**
- Sanitized GitHub-flavoured Markdown with KaTeX and syntax-highlighted code (copy and download per block)
- Tables render sortable with copy-as-CSV
- Charts via Recharts, Mermaid diagrams with a source toggle, generated images, TTS audio players
- Long documents open in a side artifact panel with downloads instead of scrolling past in the chat

**Everything else**
- Usage and estimated spend per model per day
- Full workspace export and import, and a scoped delete-all
- Command palette (Cmd/Ctrl+K), keyboard shortcuts, responsive layout with a sheet sidebar on phones

## Running on Replit

Everything works out of the box — the database is pre-provisioned and both services start via workflows:

- **Web app** — `artifacts/nexus` (React + Vite), served at `/`
- **API server** — `artifacts/api-server` (Express 5), served at `/api`

Sign in with the Replit account button, then open **Settings → Providers** to connect a provider. Nothing else works until at least one provider is connected.

First run, in order:

```bash
pnpm --filter @workspace/db run push   # create the tables
pnpm run build                          # typecheck + build both services
```

## Getting Cloudflare credentials

You need two values for the **Cloudflare Workers AI** provider card:

1. In the Cloudflare dashboard, go to the **Workers AI** page and select **Use REST API**.
2. Select **Create a Workers AI API Token**, review the prefilled information, create it, and copy the token. The token needs the **Workers AI** permission.
3. Your **Account ID** is in the dashboard sidebar (or on the same Workers AI page).

Paste both into Settings → Providers → Cloudflare Workers AI, hit **Save**, then **Test connection** — Nexus makes one real, cheap API call (`max_tokens: 1` against `@cf/meta/llama-3.1-8b-instruct-fp8`) and reports OK or the exact provider error.

Then open **Settings → Models** and press **Refresh** to pull the live catalogue.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes (runtime-managed on Replit) | Postgres connection string |
| `SESSION_SECRET` | Yes | Session cookie signing; also the fallback encryption secret |
| `ENCRYPTION_KEY` | Recommended off-Replit | AES-256-GCM key source for credentials and vault secrets at rest. Any long random string; derived via SHA-256 |
| `AUTH_MODE` | No | `replit` (default on Replit — OIDC sign-in) or `local` (default elsewhere — email+password) |
| `ISSUER_URL` | No | OIDC issuer override (defaults to Replit's) |
| `WEB_ORIGIN` | Only for split-origin | Public origin of the web frontend (e.g. `https://app.example.com`) — enables the CORS allowlist, cross-site session cookies and frontend-bound auth redirects |
| `STORAGE_DIR` | No | Where uploads, generated images, TTS audio and screenshots are written. Defaults to `./uploads` |
| `MAX_UPLOAD_BYTES` | No | Per-file upload cap. Defaults to 200 MB |
| `FFMPEG_PATH` / `FFPROBE_PATH` | No | Override the ffmpeg binaries. Without ffmpeg, video ingestion and long-audio chunking are disabled and the UI says so |
| `BROWSER_WS_ENDPOINT` | No | DevTools WebSocket URL of a CDP-speaking browser. Enables real browser control |
| `BROWSER_CDP_URL` | No | HTTP base (e.g. `http://127.0.0.1:9222`) to discover the WebSocket URL from instead |
| `MCP_ALLOW_STDIO` | No | Set to `1` to allow stdio MCP servers. Off by default because it spawns local processes |

## Optional capabilities

Nexus degrades honestly rather than failing opaquely. Each of these is optional, and **Settings → About** reports which are active on your install and why:

- **pgvector** — detected at boot. When present, embeddings are mirrored into a `vector` column and similarity runs in Postgres. Otherwise vectors stay in `jsonb` and cosine similarity runs in-process, which is fine for a few thousand chunks and slow beyond that. Both sit behind one repository interface, so installing the extension later needs no code change.
- **ffmpeg** — required for video ingestion and for chunking audio longer than the transcription model accepts. Audio already in an accepted format still transcribes without it.
- **A CDP browser** — required to click and type in pages. Without it, pages can still be read; the browser tools disappear from the model's options rather than pretending to work.
- **A search API key** — store `BRAVE_API_KEY`, `TAVILY_API_KEY` or `SERPER_API_KEY` in Settings → API Keys for better search. Without one, search falls back to a keyless DuckDuckGo scrape.

To enable browser control locally, run a browser with remote debugging and point Nexus at it:

```bash
# Local Chrome
chrome --remote-debugging-port=9222 --headless=new
# then set BROWSER_CDP_URL=http://127.0.0.1:9222

# Or a container
docker run -p 3000:3000 ghcr.io/browserless/chromium
# then set BROWSER_WS_ENDPOINT=ws://127.0.0.1:3000
```

## Running anywhere else (self-hosted)

Nexus is host-agnostic by design — nothing hard-codes a Replit-only service:

1. Provide a Postgres database and set `DATABASE_URL`. Install the `pgvector` extension if you can.
2. Set `SESSION_SECRET` and `ENCRYPTION_KEY` to long random strings.
3. Set `AUTH_MODE=local` (the default off-Replit) — the sign-in screen switches to email+password with bcrypt and httpOnly session cookies.
4. Install dependencies with `pnpm install`, push the schema with `pnpm --filter @workspace/db run push`.
5. Install `ffmpeg` if you want video and long-audio support.

### Deployment topology

The web app calls the API at relative `/api/...` paths, so both services must be reachable under one origin — or you must tell the web app where the API lives. Pick one:

**Option A — same origin via reverse proxy (recommended).** Put a proxy in front that routes `/api/*` to the API server and everything else to the web server. Session cookies are same-origin and everything just works:

```nginx
location /api/ {
  proxy_pass http://127.0.0.1:8080;
  # SSE needs buffering off, or streaming arrives as one delayed blob
  proxy_buffering off;
  proxy_read_timeout 600s;
}
location / { proxy_pass http://127.0.0.1:3000; }
```

**Option B — split origins.** Serve both ends over HTTPS, set `WEB_ORIGIN=https://app.your-domain.com` on the API (the frontend's public origin), and build the web app with `VITE_API_URL=https://api.your-domain.com`. Credentialed CORS is then allowlisted to your frontend origin only, session cookies are issued `SameSite=None; Secure` so browsers attach them cross-site, cookie-authenticated mutations are origin-checked, and sign-in/logout redirects land back on the frontend. HTTPS is required on both ends — browsers reject `SameSite=None` cookies without `Secure`.

For local development off-Replit, run both dev servers and set `API_PROXY_TARGET=http://localhost:8080` before `pnpm --filter @workspace/nexus run dev` — Vite will proxy `/api` for you.

Then start the API (`pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/api-server run start`) and the web app (`pnpm --filter @workspace/nexus run build && pnpm --filter @workspace/nexus run serve`) with `PORT` and `BASE_PATH` set.

## Security model

- Every page and API route is behind authentication; unauthenticated requests get 401 or the sign-in screen.
- Credentialed cross-origin access is allowlisted to a configured frontend origin (`WEB_ORIGIN`); cookie-authenticated mutations are origin-checked against CSRF; cookies are `SameSite=Lax` same-origin and `SameSite=None; Secure` in split-origin mode.
- Provider credentials and vault secrets are encrypted at rest with AES-256-GCM and are write-only over the API — responses contain only masked previews like `••••4f2a`.
- **Tools are deny-by-ask.** MCP servers and browser control are arbitrary remote code paths reachable from a publicly-hosted app, so nothing that writes, spends money, or reaches outside the account runs without explicit approval. Every attempt — approved, denied or failed — is audited.
- MCP server credentials are never stored on the server record: the record holds a header/env name → vault secret-name mapping, resolved server-side at connect time only.
- Every user-supplied URL (custom provider endpoints, MCP servers, web tools, browser navigation) is SSRF-guarded: HTTPS-only for provider endpoints, DNS-resolved, private/loopback/link-local/metadata addresses blocked, and redirects re-validated at every hop rather than followed blindly.
- Uploads are MIME-allowlisted, size-capped, and stored under server-generated random names, so a hostile filename can't influence the path on disk. Archive expansion rejects path traversal and caps total inflated size against decompression bombs.
- Model output renders as sanitized Markdown with raw HTML disabled, and Mermaid runs at `securityLevel: 'strict'`.
- Chat, upload, agent-run, catalogue-refresh, MCP-test and skill-generation endpoints are rate-limited per session.
- Key material, file contents, and prompts are never logged.
- The data export deliberately excludes all credentials, so a portable backup can't leak your keys. Imported MCP servers arrive disabled until their secrets are re-entered.

## Accessibility

Semantic markup, ARIA live regions on the streaming output, correct roles on the composer and approval prompts, full keyboard reachability, visible focus rings, and `prefers-reduced-motion` support. Full WCAG conformance still needs manual testing with a screen reader and expert review — this hasn't had either.

## Repo map

- `artifacts/nexus/` — React + Vite frontend (Tailwind, shadcn/ui, wouter)
  - `src/lib/api.ts` — typed API client and SSE helpers · `src/lib/queries.ts` — React Query hooks
  - `src/pages/` — chat, library, agents, browser, settings
  - `src/components/chat/`, `components/output/`, `components/settings/`
- `artifacts/api-server/` — Express API
  - `src/lib/ai/` — the provider abstraction layer (chat, embed, transcribe, image, TTS, rerank, catalogue, defaults, usage)
  - `src/lib/tools/`, `src/lib/mcp/`, `src/lib/permissions.ts` — tools, MCP client, authorization
  - `src/lib/agents/` — multi-agent orchestration · `src/lib/chatEngine.ts` — the chat turn
  - `src/lib/rag/`, `src/lib/memory.ts`, `src/lib/ingest/` — retrieval, memory, file ingestion
  - `src/lib/browser/` — SSRF guard, HTML extraction, CDP client, web search
  - `src/routes/` — one router per feature area
- `lib/db/src/schema/` — Drizzle schema · `lib/db/src/vectors.ts` — the pgvector/JSON repository
- `lib/api-spec/openapi.yaml` — contract for the auth and provider endpoints; run `pnpm --filter @workspace/api-spec run codegen` after changes

## Tests

```bash
pnpm run typecheck                                    # every package
pnpm --filter @workspace/api-server run build && \
  pnpm --filter @workspace/api-server run test        # deployment-topology e2e (needs DATABASE_URL)
```
