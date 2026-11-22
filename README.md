# GloryTecks Admin Backend

Express + TypeScript API powering the GloryTecks admin panel and the public
read-only API consumed by the marketing website.

**Stack:** Node.js · Express · Supabase PostgreSQL · Supabase Auth · Redis · Cloudinary

> Migrated from MongoDB/Mongoose and a self-signed JWT system. Cloudinary,
> Redis, every API route and every response shape are unchanged — see
> [`docs/MIGRATION.md`](docs/MIGRATION.md).

## Prerequisites

- Node.js 18+
- A **Supabase** project (cloud) or the **Supabase CLI** for a local stack
- Redis — optional (response caching; the app runs fine without it)
- Cloudinary account — optional in dev; upload endpoints return 503 until configured

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file
cp .env.example .env

# 3. Bring up a database (pick ONE)

#    a) Local stack — starts Postgres, Auth, PostgREST and Studio in Docker,
#       applies every migration in supabase/migrations, and prints your keys:
npx supabase start

#    b) Cloud project — link it and push the migrations:
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF
npx supabase db push

# 4. Fill SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env

# 5. Seed the database (creates the admin account + sample content)
npm run seed          # full seed — local stack only; a hosted project needs
                      # `-- --allow-remote` (and `--allow-remote-wipe` with --fresh)
# npm run seed:admin  # accounts only

# 6. Start the dev server (auto-reloads on changes)
npm run dev
```

The API listens on `http://localhost:5000/api/v1` (configurable via `PORT` / `API_PREFIX`).

## Supabase CLI workflow

| Task | Command |
|---|---|
| Install the CLI | `npm i -D supabase` (used here via `npx`) or `brew install supabase/tap/supabase` |
| Log in | `npx supabase login` |
| Link a cloud project | `npx supabase link --project-ref YOUR-PROJECT-REF` |
| Start the local stack | `npx supabase start` |
| Stop the local stack | `npx supabase stop` |
| Apply migrations to the linked project | `npx supabase db push` (or `npm run db:push`) |
| Reset the local database and replay every migration | `npx supabase db reset` (or `npm run db:reset`) |
| Create a new migration | `npx supabase migration new add_something` |
| Check what has been applied | `npx supabase migration list` |

Migrations are the only supported way to change the schema. Nothing has to be
clicked together in the Supabase dashboard: a clean project plus `db push`
plus `npm run seed` yields a fully working install.

## Database schema

`supabase/migrations/` — applied in filename order:

| File | Contents |
|---|---|
| `20260101000000_initial_schema.sql` | 19 content tables, primary/foreign keys, CHECK constraints, `updated_at` triggers |
| `20260101000100_singletons.sql` | `settings` and `about_page`, one row each, defaults reproducing the previous schema defaults |
| `20260101000200_indexes.sql` | Indexes derived from the queries the app actually issues |
| `20260101000300_functions.sql` | `get_or_create_settings()`, `get_or_create_about_page()`, `distinct_blog_tags()` |
| `20260101000400_rls.sql` | Row Level Security enabled deny-by-default on every table |

21 tables in total. Relationships: `blogs.author_id → authors.id`,
`courses.trainer_id → trainers.id` (both `ON DELETE SET NULL`), and
`admin_users.id → auth.users.id` (`ON DELETE CASCADE`).

### Row Level Security

RLS is **on for every table with no policies attached**. Neither frontend holds
a database key — both call this API, which authorizes each request itself and
then queries Postgres with the service-role key (which bypasses RLS by design).
So a leaked anon key grants nothing. To let a future Next.js app read published
content directly from Supabase, add narrow `SELECT` policies in a new migration;
no backend change is needed.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Project API URL |
| `SUPABASE_ANON_KEY` | yes | Login only — exchanges credentials for a session |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **Server-only.** All database access + Auth admin calls |
| `SUPABASE_JWT_SECRET` | no | Enables in-process HS256 token verification (skips a network hop) |
| `COOKIE_SECRET` | yes in prod | Signs the refresh-token cookie |
| `COOKIE_SECURE` / `COOKIE_SAMESITE` | no | Cookie flags; `none` + `true` for cross-site |
| `CORS_ORIGINS` | no | Admin frontend origins |
| `PUBLIC_CORS_ORIGINS` | no | Marketing site origins (`*` allowed) |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` / `_UPLOAD_FOLDER` | no | Unchanged |
| `REDIS_URL` / `REDIS_KEY_PREFIX` / `CACHE_ENABLED` | no | Unchanged |
| `SITE_API_KEY` | no | Sent by the marketing site's server (`x-gt-site-key`) so its build and ISR reads skip the per-address public READ ceiling (never writes, uploads, auth or admin routes). Same value as the site's `API_SITE_KEY`. Production: 32+ chars when set; unset is logged |
| `SITE_REVALIDATE_URL` / `SITE_REVALIDATE_SECRET` | no | Tell the marketing site to refresh after a CMS write (see *Site revalidation*). Secret: 32+ chars, equal to the site's `REVALIDATE_SECRET`; never logged. `SITE_REVALIDATE_TIMEOUT_MS` optional (4000) |
| `SEO_AUDIT_ORIGIN` | no | The one origin the technical SEO audit may crawl: `https://glorytecks.com`, a subdomain of it, or a `*.vercel.app` deployment. Unset = audit off. `SEO_AUDIT_MAX_PAGES` (300, 10–1000) and `SEO_AUDIT_STEP_MS` (8000, 4000–25000) optional (see *Technical SEO audit*) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | no | A Google service account for the read-only Search Console and GA4 reports (`client_email` and `private_key` from its JSON key; `\n` escapes accepted). Never logged or sent to the browser. With `GSC_SITE_URL` (`sc-domain:glorytecks.com`, or a URL-prefix property with its trailing `/`) and/or `GA4_PROPERTY_ID` (the numeric property ID, not `G-…`). All unset = integrations off (see *Search Console and GA4*) |
| `RATE_LIMIT_*` / `AUTH_RATE_LIMIT_MAX` | no | Unchanged |
| `SEED_*` | no | Bootstrap accounts |
| `MONGODB_URI` | no | **Import script only.** Never read by the running API |

In production the app refuses to boot when a required variable is missing.

## Authentication

Supabase Auth issues and verifies tokens; this API decides what they may do.

```
Admin frontend
   │  POST /auth/login { email, password }
   ▼
Express  ──►  Supabase Auth (signInWithPassword)
   │              └─► access token + refresh token
   │
   ├─ refresh token  ──►  httpOnly cookie  gt_refresh_token
   └─ access token   ──►  response body    data.accessToken
                              │
                              ▼
              Authorization: Bearer <access token>
                              │
                        requireAuth
                    verify token (local HS256, or Supabase Auth)
                              │
                    read role from public.admin_users   ← never from the token
                              │
                         authorize(...roles)
                              ▼
                    controller → service → repository → PostgreSQL
```

Endpoints, request bodies, response envelopes, status codes and the cookie name
are all unchanged, so **the admin frontend needs no modifications.**

### Admin-only access

- No signup route exists in this API, and `enable_signup = false` in `supabase/config.toml`.
- Authorization comes from `admin_users`, never from a token claim or request body.
- A Supabase identity **with no `admin_users` row is rejected with 401**. That is
  the load-bearing guarantee: even if signup were enabled on the project, a
  self-registered account could not reach a single endpoint.
- Accounts are created only by `npm run seed:admin` or by an existing admin
  through `POST /admins`.

### Roles

`admin`, `editor`, `viewer`, `receptionist`, `content_writer` — unchanged.
Blogs/courses/uploads and the People & Proof resources are open to
`admin` + `content_writer`; leads to `admin` + `receptionist`; everything else
is admin-only.

## Architecture

```
src/
  config/        env, supabase clients, redis, cloudinary, logger
  constants/     roles, statuses, enums, upload limits
  controllers/   request/response handling + the generic CRUD factory
  services/      business logic (auth, blog, course, upload, resource registry)
  repositories/  data access — the only layer that talks to Supabase
  db/            table definitions + row ⇄ API mapping
  routes/        route definitions and guards
  middlewares/   auth, validation, rate limiting, uploads, errors
  validators/    express-validator chains
  utils/         ApiError, ApiResponse, blocks renderer, slugs, query parsing
  seed/          seed scripts + site content data
  scripts/       one-time MongoDB → Supabase import
supabase/
  migrations/    SQL schema migrations
tests/           unit tests
```

Request flow: **Routes → Controllers → Services → Repositories → Supabase PostgreSQL.**
Cloudinary and Redis keep their own service/utility layers, untouched.

## Cloudinary

Unchanged. Cloudinary is still the file store; PostgreSQL stores only URLs and
public IDs, exactly as MongoDB did. Uploads stream through
`cloudinary.uploader.upload_stream`, deletions use `uploader.destroy`, and the
brochure proxy still streams PDFs through this domain so the Cloudinary URL is
never exposed. **No asset was moved, re-hosted or re-uploaded by the migration.**

## Redis

Unchanged. Same cache-aside `cacheWrap`, same keys, same TTLs, same
SCAN-based pattern invalidation on every admin mutation. Rate limiting also
still uses `express-rate-limit` (it never used Redis).

## Site revalidation

Every CMS write handler awaits `invalidateResource(resource, { before, after })`
(`src/lib/cacheInvalidation.ts`): it purges Redis, then — only if the change is
public (published/active before or after the write) — POSTs the affected cache
tags to the site's `/api/revalidate` (`src/lib/siteRevalidation.ts`). Draft
saves, leads, chat and brochures never notify; a body-only edit of a published
post sends just that post's tag. Failures are logged and never fail the write;
the site then refreshes on its ISR timer. Unset `SITE_REVALIDATE_URL` /
`SITE_REVALIDATE_SECRET` disables it with one warning.

Each refresh that is actually sent is recorded in `site_refresh_log`
(`src/lib/siteRefreshLog.ts`): resource, site tags, `sent` or `failed`, a short
reason such as `HTTP 503`, attempts and time. Never the secret or the request
body. Skipped notifications are not recorded. The admin dashboard uses this to
show refreshes that failed and that no later refresh has covered. Apply
migration `20261024000000_site_refresh_log.sql` to turn it on; until then the
API notices the table is missing, stops trying for ten minutes at a time, and
the dashboard reports refresh history as not set up. Rollback (by hand only):
`supabase/rollbacks/20261024000000_site_refresh_log.down.sql`.

Public GETs send `Cache-Control: public, max-age=0, s-maxage=0, must-revalidate`:
the only reader is the site's server, which caches each response itself, and an
edge copy here could be re-read by the site right after a save.

Tag map and verification: `main-website/docs/CACHING_AND_REVALIDATION.md`.

## Page SEO

Search and social overrides for non-blog pages (`/api/v1/page-seo`, admin
only; `GET /api/v1/public/page-seo` for the site). Fixed pages, resource
pages and landings are stored by path in `page_seo`. Courses and `/about` keep
their SEO on their own record. Every change is recorded in `seo_audit_log`
(field names only, never values). Only admins may change indexing — content
writers can edit a course's SEO text but get 403 on noindex/nofollow.

The editable paths and their default titles live in `src/seo/pageSeoRegistry.ts`;
main-website's `lib/seo/pageSeoParity.test.ts` fails if they drift from the
site.

`GET /api/v1/page-seo/checks` (admin only, read-only) runs the SEO checks
behind the admin's *SEO health* screen over the same pages: title and
description length, superlatives, outcome promises, place-name stuffing,
duplicate titles and descriptions, hidden and not-live pages. The rules are
`src/seo/pageChecks.ts`, a copy of the site's own copy rules
(`main-website/lib/guardrails/copyRules.ts`); `lib/seo/pageChecksParity.test.ts`
fails if the two differ. Findings describe saved text and settings, never
rankings, and blog posts are not covered. Apply migration `20261015000000_page_seo.sql` **before** deploying this
backend (it reads the new columns). Rollback, export/restore
(`npx tsx src/scripts/page-seo.ts export|check|to-sql`) and the full rules:
`main-website/docs/PAGE_SEO_EDITING.md`.

## Dashboard

The admin home page reads five endpoints under `/api/v1/dashboard`. Every role
has a dashboard, so the role decides each section **on the server**
(`src/services/dashboard.service.ts`); a section a role may not see is absent
from the response, never fetched and then hidden. Each section fails on its own
(`{ "state": "error" }`, or `"not-set-up"` for a table whose migration has not
been applied), so one broken source never blanks the page.

| Endpoint | Who | What |
|---|---|---|
| `GET /dashboard/stats` | any role | Headline counts (every role, by design) and the five most recent posts, courses, enquiries and demo requests (posts and courses to content roles only, leads to lead roles only). Cached 120 s in **one** shared key; the role filter runs on the way out of the cache, on every request. Carries `generatedAt` and `cacheTtlSeconds`. |
| `GET /dashboard/status` | any role; details admin-only | Database answering and its latency; whether the public site answers (one `HEAD /` to the host in `SITE_REVALIDATE_URL`, no redirects followed, 5 s timeout, result shared for 5 minutes). Admins also get each integration's state with variable **names** only (site refresh, uploads, cache, site key, sign-in links), the deployment commit, and site-refresh history for the last 7 days. |
| `GET /dashboard/attention` | role-scoped | Leads still `new` 24 h after arriving (lead roles), drafts untouched for 14 days (content roles), active batches whose start date has passed or cannot be read (admins). Counts and dates only; no lead names, emails or phones. |
| `GET /dashboard/activity?kind=all\|seo\|site&limit=1-50` | admin | The SEO change log and the site refresh log, merged newest first. Persisted events only. |
| `GET /dashboard/trends?range=7\|30\|90&tz=<minutes>` | role-scoped | Daily counts from each record's own date: leads by arrival (lead roles), posts by first publication (content roles). `tz` is the caller's UTC offset in minutes. A previous-period total is given only when the data reaches back before that period; otherwise `null`, never an estimate. |

Only `stats` (one shared key) and the website check (no role-specific data) are
cached; `tests/dashboardCache.test.ts` pins both on the real Redis code path.

## Technical SEO audit

`/api/v1/seo-audit` (admin only) crawls the public site with **the site's own
SEO checks** and keeps each issue's history; the admin's *Technical SEO audit*
screen drives it. Needs migration `20261025000000_site_audit.sql` (three new
tables; rollback in `supabase/rollbacks/`) and `SEO_AUDIT_ORIGIN`. Without
either, the endpoints say so (`503`) and the overview explains what to set.

**Same checks as the site.** The readings and predicates come from
`main-website/lib/seo/{smoke,intent,pageAudit,canonical}.ts`,
`lib/guardrails/claimPatterns.ts` and the full crawl
`lib/seo/sitecrawl.live.test.ts`. The backend deploys separately, so it keeps
verbatim copies of those declarations in `src/seo/site/` (generated; do not
edit). `main-website/lib/seo/auditParity.test.ts` fails if any copy differs from
the site's, token for token. Editorial hints reuse `src/seo/pageChecks.ts`. The
rule list, with each rule's reason, fix and source, is `src/seo/audit/rules.ts`.
Findings describe what the site serves; none predicts rankings.

**How a run works.** Vercel functions do not keep running after a response, so
a crawl is a row in `site_audit_runs` that the admin screen advances with
`POST /runs/:id/step`, one time-boxed step at a time (`SEO_AUDIT_STEP_MS`).
A step leases the run (compare-and-set on `lease_until`), saves its progress,
and releases it; a step that dies lets the lease lapse and the next step
carries on. Phases: robots.txt and sitemaps → pages (registry, published CMS
records, then sitemap URLs, best first, up to `SEO_AUDIT_MAX_PAGES`) → link
targets → images → analysis. Closing the screen pauses a run; it can be resumed
or cancelled. A finished run's results are reused for 10 minutes before
another run may start. Opening the screen never crawls.

**Safety.** Only https, on the default port, to the origin and its www/apex
twin; images also to `MEDIA_URL_HOSTS`. Every resolved address is checked
before connecting (private, loopback, link-local and cloud metadata, CGNAT,
multicast, reserved, IPv4-mapped, NAT64 and 6to4 ranges), IP-literal hosts are
refused, redirects are followed by the audit only to approved hosts, and each
request has a deadline and a size cap (`src/lib/safeHttp.ts`). robots.txt is
obeyed for the audit's own token `GloryTecksSEOAudit` (RFC 9309; a 5xx or 429
robots.txt stops the run). At most 3 requests at a time, 3 tries per URL.

**Issues.** One row per fingerprint (origin + rule + path), with first and
last seen, how many runs reported it, and how often it came back. An open
issue is resolved only if the run actually looked at what it is about; pages
a run did not reach (budget, robots.txt, timeouts) keep their issues as they
were, and graph checks (orphans, weak links, duplicate titles) wait for a run
that checked every URL. Retrying the latest run's failed URLs re-analyses it
without counting it twice. Cancelling is refused once analysis has started.

| Endpoint | What |
|---|---|
| `GET /seo-audit/overview` | Configuration, the run in progress, the latest and previous completed runs, open issue counts by severity, the cooldown, the rule catalogue |
| `GET /seo-audit/runs` · `GET /seo-audit/runs/:id` | Runs, newest first, with progress, coverage and summary |
| `POST /seo-audit/runs` | Start a run (one at a time; 409 during the cooldown) |
| `POST /seo-audit/runs/:id/step` · `/cancel` · `/retry` | Advance, stop or re-check a run |
| `GET /seo-audit/issues` | Filter (status, severity, category, page type, rule, URL, first/recurring), sort, paginate |
| `GET /seo-audit/issues/:id` | One issue: why, fix, source, evidence, affected pages with admin links |
| `GET /seo-audit/issues/export?format=csv\|json` | The same filters as a file (CSV cells guarded against formulas) |

Analysis runs in one step. At the default 300 pages it fits a 10-second
function; at the 1000-page cap, raise the function's maximum duration
(Vercel `maxDuration`) or keep the budget lower. Older runs keep their URL list
but drop the bulky page readings once a newer run is analysed.

## Search Console and GA4

`/api/v1/analytics` (admin only) reads Google Search Console and Google
Analytics 4 for the admin's *Search performance*, *Visitors* and
*Integrations* screens. Read-only and optional: unset, the endpoints answer
with a "not configured" state and the rest of the API is unaffected.

**Why a service account.** One organisation, one property each: a service
account added to each property with the least access that can read reports
(Search Console *Restricted*, GA4 *Viewer*) needs no personal Google sign-in,
nothing expires when someone leaves, and no OAuth tokens are stored. End-user
OAuth would only be worth it if different people had to connect different
Google identities.

**Auth.** The OAuth 2.0 JWT bearer flow (RFC 7523) with `node:crypto` — no
Google client library. Scopes `webmasters.readonly` and `analytics.readonly`
only. Access tokens are cached in process memory until a minute before they
expire; nothing is persisted, so there is nothing to encrypt. Token errors are
branched on Google's `error` string (`invalid_grant` account-not-found, bad
signature, clock skew; `disabled_client`, …) into a next step that names the
variable to fix. `src/integrations/google/`: `config` (lazy validation: errors
name variables, never values), `auth`, `http` (8 s per attempt, one retry on
5xx only, redacted errors), `schema` (every response is validated; a wrong shape
is `bad-response`, never wrong numbers), `searchConsole`, `analytics`, `reports`
(pure arithmetic).

**Quota.** Reports are cached in Redis (Search Console 6 h, GA4 1 h) with a
7-day last-good copy. Quota answers are never retried: Search Console asks for
15 minutes, AIP-194 says hours, so the service holds off for at least 15
minutes (or Google's `Retry-After`) and serves the last good copy, marked
stale. Simultaneous requests for one report share one set of Google calls. GA4's
five core reports go as one `batchRunReports` request (Standard properties allow
10 concurrent requests and count 5xx answers against an hourly quota). A small
sync record per property (last success, last failure, latest data date, hold-off)
lives in Redis for 30 days, in memory without Redis.

**What is asked for.** Search Console: `sites.get` (access check), and
`searchAnalytics.query` for web search by date (two periods), query, page,
device and country — top 250 queries and pages, final data only, Pacific Time
days ending on the latest day with data. GA4: active users, sessions, views,
engaged sessions, engagement rate and key events (two periods, the property's
time zone, relative dates ending yesterday), daily, landing pages
(`landingPage`, no query strings), `sessionSourceMedium`,
`sessionDefaultChannelGroup`, and counts for the property's own key events
(Admin API `keyEvents.list`; nothing is assumed). Google organic sessions mean
`google / organic`, Google's own definition, shown beside Search Console clicks
and never merged with them. There is no "request indexing": the API has none;
the admin links to Search Console.

| Endpoint | What |
|---|---|
| `GET /analytics/integrations` | Both connections: state, identifiers, service account address, last sync, last failure, hold-off |
| `POST /analytics/integrations/:provider/test` | Ask Google now (`search-console` or `analytics`); rate-limited |
| `GET /analytics/search-console?range=7\|28\|90[&refresh=1]` | Search Console report; `refresh=1` skips the cache (rate-limited) |
| `GET /analytics/ga4?range=7\|28\|90[&refresh=1]` | GA4 report |

Reports always answer 200 with `{connection, report, fetchedAt, stale, error}`,
so a failure on Google's side is shown, never a broken page. The dashboard's
status reads the sync record only — it never calls Google. The setup guide
(APIs to enable, access to grant, key rotation, the organisation policy that can
block key creation, Workload Identity Federation as the keyless option) is in
the admin's Integrations screen and in the Phase 4 setup document.

## Scripts

- `npm run dev` — development server with hot reload
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled server
- `npm run typecheck` — type-check without emitting
- `npm run lint` — ESLint
- `npm test` — unit tests (no database required)
- `npm run seed` / `npm run seed:admin` — seed content / accounts
- `npm run db:push` / `npm run db:reset` — apply / replay migrations
- `npm run migrate:mongo` — one-time MongoDB import (see below)

## Importing existing MongoDB data

```bash
# Always dry-run first — reports what would be written, changes nothing.
MONGODB_URI="mongodb+srv://..." npm run migrate:mongo -- --dry-run

# Then import for real.
MONGODB_URI="mongodb+srv://..." npm run migrate:mongo
```

- Non-destructive: **nothing is ever deleted from MongoDB.**
- Re-runnable: rows are upserted on a deterministic primary key derived from the
  ObjectId, so a second run updates rather than duplicates.
- Administrators keep their existing passwords — bcrypt hashes transfer to
  Supabase Auth directly.
- Cloudinary URLs and public IDs are copied as-is; **no image is touched.**
- Failures are reported per document with a reason; fix and re-run safely.

Import one collection at a time with `--only=blogs`.

## Testing

`npm test` runs the unit suite with no database or network:

- row ⇄ API mapping (null omission, timestamp format, partial writes, projections)
- query translation, asserted against a recording stand-in for the PostgREST
  client — filters, sort direction and null ordering, paging offsets, search
- injection guards: unknown sort/filter keys dropped, search terms quoted and
  LIKE-escaped, unknown body keys never written
- content-block renderer parity, slug generation, ObjectId→UUID mapping
- database error → HTTP status mapping, and that SQL detail never leaks

For end-to-end checks against a live stack, see the manual matrix in
[`docs/MIGRATION.md`](docs/MIGRATION.md).

## Common startup problems

| Symptom | Cause | Fix |
|---|---|---|
| `Could not reach Supabase at …` on boot | Wrong URL/key, or migrations not applied | Check `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`; run `npm run db:push` |
| `Missing required environment variable: …` (production only) | Secrets unset with `NODE_ENV=production` | Set the Supabase keys and `COOKIE_SECRET` |
| Login returns 401 for a known-good password | Auth identity exists but has no `admin_users` row | Run `npm run seed:admin`, or create the admin via `POST /admins` |
| `relation "public.blogs" does not exist` | Migrations not applied | `npm run db:push` (cloud) or `npx supabase db reset` (local) |
| Uploads fail / disabled | Cloudinary not configured | Set the three `CLOUDINARY_*` vars |
| Redis connection warnings | No Redis running | Harmless — caching is skipped. Set `CACHE_ENABLED=false` to silence |

## Deployment

1. Apply migrations to the production project: `npx supabase db push`.
2. Set the environment variables on the host. `SUPABASE_SERVICE_ROLE_KEY` must be
   a server-side secret — never expose it to a build that ships to the browser.
3. For cross-site cookies set `COOKIE_SECURE=true` and `COOKIE_SAMESITE=none`,
   and list the admin origin in `CORS_ORIGINS`.
4. `npm run build && npm start`, or deploy to Vercel using the included
   `vercel.json`.

Serverless note: Supabase is reached over stateless HTTP, so there is no
connection to warm up. The per-request database-connection guard the MongoDB
setup needed on Vercel has been removed.
