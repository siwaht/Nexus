# Nexus

A self-hosted AI chat workspace — a cleaner, more capable alternative to the ChatGPT web UI that users run themselves and point at Cloudflare Workers AI (and other providers) with their own API keys.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (managed workflow provides PORT)
- `pnpm --filter @workspace/nexus run dev` — run the web app (managed workflow provides PORT + BASE_PATH)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` (runtime-managed), `SESSION_SECRET`; recommended: `ENCRYPTION_KEY`; optional: `AUTH_MODE` (`replit`|`local`), `ISSUER_URL`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind + shadcn/ui + wouter (`artifacts/nexus`)
- API: Express 5 (`artifacts/api-server`)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod v4 (`zod` catalog is pinned to ^4 — Orval 8 generates v4-only APIs; do not downgrade)
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/nexus/` — web app: shell (`src/components/app-shell.tsx`), sign-in (`src/components/sign-in-screen.tsx`), settings (`src/pages/settings.tsx`, `src/components/settings/`)
- `artifacts/api-server/src/routes/` — `auth.ts` (OIDC), `localAuth.ts` (AUTH_MODE=local + `/auth/config`), `providers.ts` (credentials CRUD + test), `health.ts`
- `artifacts/api-server/src/lib/` — `providers.ts` (provider registry + test-connection adapters), `crypto.ts` (AES-256-GCM), `rateLimit.ts`, `auth.ts` (sessions)
- `lib/db/src/schema/` — `auth.ts` (users/sessions), `nexus.ts` (all domain tables)
- `lib/api-spec/openapi.yaml` — API contract (source of truth)

## Architecture decisions

- **Portable auth**: `AUTH_MODE` env var selects Replit OIDC or local email+password (bcrypt + httpOnly session cookies); one `authMiddleware` gates all API routes either way.
- **Provider abstraction**: providers are declarative entries in `artifacts/api-server/src/lib/providers.ts`; adding one = one registry entry + one adapter. Cloudflare is one provider among many.
- **Encrypted credentials**: provider keys are AES-256-GCM encrypted at rest (key derived from `ENCRYPTION_KEY`/`SESSION_SECRET`) and write-only over the API — only masked previews leave the server.
- **Host-agnostic**: every platform-specific service sits behind an env-selected driver so the app can run on Replit, Cloudflare-adjacent hosting, Weblet, or the user's own machine.

## Product

Milestone 1 (complete): auth wall, app shell (sidebar/top bar), Settings → Providers with encrypted key storage + live connection testing for 11 providers (Cloudflare Workers AI, Cloudflare AI Gateway, OpenRouter, OpenAI, Anthropic, Google AI Studio, Groq, Mistral, DeepSeek, xAI, custom OpenAI-compatible). Milestones 2–10 (model catalogue, streaming chat, files, RAG, media, memory, books, rich output, gateway/usage/polish) are planned as tasks #2–#10.

## User preferences

- Hosting is undecided (Replit / Cloudflare / Weblet / own computer) — keep the app host-agnostic; never hard-code Replit-only services.
- Cloudflare Workers AI is the primary model source; also support OpenRouter and direct providers (OpenAI, Mistral, Gemini, Anthropic, others) behind the same abstraction.
- Verify Cloudflare endpoint shapes against developers.cloudflare.com docs when building provider features.

## Gotchas

- Zod catalog must stay v4 (`^4.x`) — Orval emits `z.email()`/`z.url()`/`z.int()`; zod 3 breaks the libs typecheck.
- Re-run `pnpm --filter @workspace/api-spec run codegen` after every `openapi.yaml` change, before using new types.
- New composite libs need `composite`/`declarationMap`/`emitDeclarationOnly` in tsconfig and a root `tsconfig.json` reference.
- Self-hosted deployments: same-origin reverse proxy for `/api`, or split-origin with `WEB_ORIGIN` (API) + `VITE_API_URL` (web build) — cookies become `SameSite=None; Secure`, CORS is allowlisted to WEB_ORIGIN, mutations are CSRF-origin-checked; dev off-Replit uses `API_PROXY_TARGET` for the Vite proxy.
- Any provider adapter that fetches a user-controlled URL must pass it through `assertPublicHttpUrl` (`artifacts/api-server/src/lib/providers.ts`) and fetch with `redirect: 'error'` — SSRF protection.
- E2E test for the documented self-hosted setup: `pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/api-server run test`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
