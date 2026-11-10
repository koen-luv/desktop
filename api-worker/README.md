# Neritium API Worker

A self-hostable backend for the Neritium client: Cloudflare Workers for the API,
Supabase (Postgres) for storage. It implements the routes the app needs to sign
in, sync a library, edit playlists, record listening history, read profiles and
show leaderboards — enough to use the app without `api.tryliner.fun`.

Passwords are hashed in Postgres with pgcrypto (bcrypt), so the Worker stays
well inside Cloudflare's free-plan CPU budget. The Worker only ever uses the
Supabase **service role** key, and every table has RLS enabled with no public
policy, so the key never reaches a client.

## 1. Create the Supabase schema

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run [`sql/schema.sql`](./sql/schema.sql).
3. Copy the project URL and the **service role** key from
   **Project Settings → API**.

The schema creates the tables, indexes, atomic playlist/history functions and
the RLS lockdown. Re-running it is safe.

## 2. Deploy the Worker

```bash
cd api-worker
npx wrangler login

npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put JWT_SECRET      # openssl rand -base64 48
# Optional human check:
npx wrangler secret put TURNSTILE_SECRET

npx wrangler deploy
```

`wrangler.toml` holds the public variables. The defaults are safe:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TURNSTILE_MODE` | `optional` | `off`, `optional` or `required` |
| `TURNSTILE_SITE_KEY` | `0x4AAAAAAFwIpK7QKp-h3zap` | Public widget key |
| `ALLOWED_ORIGINS` | `*` | Comma-separated allowlist, or `*` for native clients |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Lifetime of the HMAC access token |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Lifetime of the rotating refresh token |

Health check: `GET /health` returns `{ "ok": true }`.

## 3. Point the app at it

Local development (`.env.local`):

```bash
VITE_API_URL=http://localhost:8787
```

Production: set `VITE_API_URL` to `https://liner-api.<account>.workers.dev` (or
your custom domain) as a repository **variable** so the desktop, Android and iOS
release builds pick it up. Restart/rebuild the app after changing it.

Turnstile in the app needs no rebuild: `/v1/auth/challenge` returns the public
site key and the app uses it. Set `VITE_TURNSTILE_SITE_KEY` only as a fallback
for an older API that does not return a key. Add every hostname the app is
served from to the Turnstile widget's allowlist: `tryliner.fun`, `localhost`,
`127.0.0.1`, `appassets.androidplatform.net` (the Android WebView) and
`liner-api.<account>.workers.dev` (the hosted check page). Packaged Electron
builds run from `file://` and use the Worker's `/v1/auth/verify` page instead of
an inline widget — that page is included.

## Why requests were being blocked by Turnstile

The old setup used Cloudflare's **edge clearance cookie**. That cookie is bound
to the API origin, so a native/WebView client can render a widget but can never
mint the cookie for its own origin; Cloudflare answers with a "Just a moment"
page and the request never reaches the API. This backend does not gate requests
on a clearance cookie at all. When Turnstile is enabled it verifies the token
**server-side** with `siteverify`, and only the two auth endpoints are gated.
Normal API calls are authenticated with the app's own HMAC bearer token.

The client also now forces the hosted check whenever the API says the edge needs
its own cookie, and sends credentials on that retry, so the same flow keeps
working if you point the app back at an edge-protected deployment.

## Routes

| Area | Routes |
| --- | --- |
| Auth | `POST /v1/auth/challenge`, `login`, `register`, `refresh`, `logout`; `GET /v1/auth/verify` |
| Profile | `GET /v1/me`, `PATCH /v1/users/me`, `GET /v1/users/search`, `GET /v1/users/:idOrUsername` |
| Social | `POST/DELETE /v1/users/:id/follow`, `GET /v1/users/:id/followers`, `following`, `playlists`, `history` |
| Library | `GET /v1/me/library/tracks`, `PUT/DELETE /v1/me/library/tracks/:id`, `GET /v1/me/library/:kind`, `PUT/DELETE /v1/me/library/:kind/:id` |
| Playlists | `GET/POST /v1/me/playlists`, `GET/PATCH/DELETE /v1/me/playlists/:id`, add/remove/move items |
| History | `POST /v1/me/playback/events`, `GET /v1/me/history`, `GET /v1/explore/popular` |
| Discovery | `GET /v1/me/recommendations/daily-mixes`, `GET /v1/leaderboards/global`, `GET /v1/leaderboards/artist/:id` |

Deliberately **not** implemented here: the music catalog, playback URL signing,
lyrics and Discord cloud presence. The client resolves all of those on-device
(YouTube/Innertube) or has its own fallbacks, and the Worker returns a `404`
with a `CLIENT_ONLY`/`DISCORD_UNAVAILABLE` code so the app does not show a
server-error toast. Password-reset emails are not sent; the sign-in screen keeps
its support-email flow.

## Operations notes

- **Rotate `JWT_SECRET`** to sign every user out; sessions remain in Postgres
  but old access tokens stop verifying.
- **Rate limiting**: add a Cloudflare Rate Limiting rule for
  `/v1/auth/login` and `/v1/auth/register` when the Worker is public. Turnstile
  is the first line of defence, rate limiting is the second.
- **Backups** are Supabase's responsibility; enable PITR on paid plans.
- **Free plan**: the Worker does no password hashing, so requests are I/O
  bound. Cloudflare's free CPU limit is still enough for the JSON transforms.
- `npx wrangler tail` streams structured request logs (method, path, status,
  duration) without headers or bodies.

## Local development

```bash
cd api-worker
cp .dev.vars.example .dev.vars   # fill in Supabase + JWT secret
npx wrangler dev                 # http://localhost:8787
```

Then run the app with `VITE_API_URL=http://localhost:8787`. Typecheck the Worker
with `npx tsc -p api-worker/tsconfig.json` from the repo root.
