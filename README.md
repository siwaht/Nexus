# Nexus

A self-hosted AI chat workspace — a cleaner, more capable alternative to the ChatGPT web UI that you run yourself and point at Cloudflare Workers AI (plus OpenRouter, OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, xAI, or any OpenAI-compatible endpoint) using your own API keys. The browser never sees a key: every model call goes through the backend.

This repository is built in milestones. **Milestone 1 (this build)** delivers the foundation: auth, the full database schema, and Settings → Providers with encrypted key storage and live connection testing. Chat, file ingestion, RAG, memory, books, rich output, and gateway routing land in subsequent milestones.

## Running on Replit

Everything works out of the box — the database is pre-provisioned and both services start via workflows:

- **Web app** — `artifacts/nexus` (React + Vite), served at `/`
- **API server** — `artifacts/api-server` (Express 5), served at `/api`

Sign in with the Replit account button on the sign-in screen, then open **Settings → Providers** to connect a provider.

## Getting Cloudflare credentials

You need two values for the **Cloudflare Workers AI** provider card:

1. In the Cloudflare dashboard, go to the **Workers AI** page and select **Use REST API**.
2. Select **Create a Workers AI API Token**, review the prefilled information, create it, and copy the token. The token needs the **Workers AI** permission.
3. Your **Account ID** is in the dashboard sidebar (or on the same Workers AI page).

Paste both into Settings → Providers → Cloudflare Workers AI, hit **Save**, then **Test connection** — Nexus makes one real, cheap API call (`max_tokens: 1` against `@cf/meta/llama-3.1-8b-instruct`) and reports OK or the exact provider error.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes (runtime-managed on Replit) | Postgres connection string |
| `SESSION_SECRET` | Yes | Session cookie signing; also the fallback encryption secret |
| `ENCRYPTION_KEY` | Recommended off-Replit | AES-256-GCM key source for provider credentials at rest. Any long random string; derived via SHA-256 |
| `AUTH_MODE` | No | `replit` (default on Replit — OIDC sign-in) or `local` (default elsewhere — email+password) |
| `ISSUER_URL` | No | OIDC issuer override (defaults to Replit's) |
| `WEB_ORIGIN` | Only for split-origin | Public origin of the web frontend (e.g. `https://app.example.com`) — enables the CORS allowlist, cross-site session cookies and frontend-bound auth redirects |

## Running anywhere else (self-hosted)

Nexus is host-agnostic by design — nothing hard-codes a Replit-only service:

1. Provide a Postgres database and set `DATABASE_URL`.
2. Set `SESSION_SECRET` and `ENCRYPTION_KEY` to long random strings.
3. Set `AUTH_MODE=local` (the default off-Replit) — the sign-in screen switches to email+password with bcrypt and httpOnly session cookies.
4. Install dependencies with `pnpm install`, push the schema with `pnpm --filter @workspace/db run push`.

### Deployment topology

The web app calls the API at relative `/api/...` paths, so both services must be reachable under one origin — or you must tell the web app where the API lives. Pick one:

**Option A — same origin via reverse proxy (recommended).** Put a proxy in front that routes `/api/*` to the API server and everything else to the web server. Session cookies are same-origin and everything just works:

```nginx
location /api/ { proxy_pass http://127.0.0.1:8080; }
location /     { proxy_pass http://127.0.0.1:3000; }
```

**Option B — split origins.** Serve both ends over HTTPS, set `WEB_ORIGIN=https://app.your-domain.com` on the API (the frontend's public origin), and build the web app with `VITE_API_URL=https://api.your-domain.com`. Credentialed CORS is then allowlisted to your frontend origin only, session cookies are issued `SameSite=None; Secure` so browsers attach them cross-site, cookie-authenticated mutations are origin-checked, and sign-in/logout redirects land back on the frontend. HTTPS is required on both ends — browsers reject `SameSite=None` cookies without `Secure`.

For local development off-Replit, run both dev servers and set `API_PROXY_TARGET=http://localhost:8080` before `pnpm --filter @workspace/nexus run dev` — Vite will proxy `/api` for you.

Then start the API (`pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/api-server run start`) and the web app (`pnpm --filter @workspace/nexus run build && pnpm --filter @workspace/nexus run serve`) with `PORT` and `BASE_PATH` set.

## Security model

- Every page and API route is behind authentication; unauthenticated requests get 401 or the sign-in screen.
- Credentialed cross-origin access is allowlisted to a configured frontend origin (`WEB_ORIGIN`); cookie-authenticated mutations are origin-checked against CSRF; cookies are `SameSite=Lax` same-origin and `SameSite=None; Secure` in split-origin mode.
- Provider credentials are encrypted at rest with AES-256-GCM and are write-only over the API — responses contain only masked previews like `••••4f2a`.
- User-supplied provider endpoints are SSRF-guarded: HTTPS-only, DNS-resolved, private/loopback/metadata addresses blocked, redirects never followed.
- Connection tests, local auth, and (in later milestones) chat/upload endpoints are rate-limited per session.
- Key material, file contents, and prompts are never logged.

## Repo map

- `artifacts/nexus/` — React + Vite frontend (Tailwind, shadcn/ui, wouter)
- `artifacts/api-server/` — Express API: auth (`src/routes/auth.ts`, `localAuth.ts`), providers (`src/routes/providers.ts`), provider adapters (`src/lib/providers.ts`), encryption (`src/lib/crypto.ts`), rate limiting (`src/lib/rateLimit.ts`)
- `lib/db/src/schema/` — Drizzle schema (all Nexus tables)
- `lib/api-spec/openapi.yaml` — API contract; run `pnpm --filter @workspace/api-spec run codegen` after changes
