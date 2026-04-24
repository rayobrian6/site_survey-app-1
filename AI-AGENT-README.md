# ⚠️ AI AGENT OPERATING MANUAL — READ THIS FIRST ⚠️

**Version:** 1.0.0 — 2026-04-25  
**Maintainer:** Ray (rayobrian6)  
**This file is the single source of truth for all AI agents working on this codebase.**  
**Every AI session MUST read this file before making any changes.**

---

## 0. MANDATORY TERMINOLOGY — NON-NEGOTIABLE

| Term | Meaning | WRONG (never use) |
|------|---------|-------------------|
| **website** | SolarPro — Next.js app on Vercel at `solarpro.solutions` | "SolarPro app", "web app", "frontend", "solar-pro" |
| **app** | Site Survey mobile app — React Native / Expo on Render | "partner app", "mobile", "partner", "survey tool" |
| **website database** | Neon PostgreSQL — owned by the website | `SOURCE_DATABASE_URL`, `WEBSITE_DATABASE_URL` |
| **app database** | Render PostgreSQL — owned by the app | `TARGET_DATABASE_URL`, `APP_DATABASE_URL` |
| **website backend** | Next.js API routes in `Solarpro-git/app/api/` | |
| **app backend** | Express API in `partner-fresh/backend/` | |

**If you use the wrong terminology in code comments, commit messages, or logs — fix it.**

---

## 1. REPOS & LOCAL PATHS

| What | Local Path | GitHub Repo | Deploy |
|------|-----------|-------------|--------|
| **website** | `/workspace/Solarpro-git/` | `rayobrian6/Solarpro` | Vercel → `solarpro.solutions` |
| **app** | `/workspace/partner-fresh/` | `rayobrian6/site_survey-app-1` | Render (backend) + Expo (mobile) |

### Git Push Pattern (ALWAYS use this exact pattern)
```bash
# Set token, push, remove token immediately
git remote set-url origin https://rayobrian6:ghp_REDACTED_SEE_PROJECT_CONTEXT@github.com/rayobrian6/<REPO>.git
git push origin master
git remote set-url origin https://github.com/rayobrian6/<REPO>.git
```

**Repos:**
- Website repo: `Solarpro`
- App repo: `site_survey-app-1`

---

## 2. ACCESS TOKENS — NEVER LOSE THESE

| Service | Token | Usage |
|---------|-------|-------|
| GitHub | `ghp_REDACTED_SEE_PROJECT_CONTEXT` | git push |
| Vercel | `vcp_REDACTED_SEE_PROJECT_CONTEXT` | `vercel --token <TOKEN>` |
| Render | `rnd_REDACTED_SEE_PROJECT_CONTEXT` | `Authorization: Bearer <TOKEN>` |

### Vercel API Pattern
```bash
curl -s "https://api.vercel.com/v9/projects/solarpro-v31/env" \
  -H "Authorization: Bearer vcp_REDACTED_SEE_PROJECT_CONTEXT"
```

### Render API Pattern
```bash
# Service ID for app backend: srv-d746gvshg0os739tqm70
curl -s "https://api.render.com/v1/services/srv-d746gvshg0os739tqm70/env-vars" \
  -H "Authorization: Bearer rnd_REDACTED_SEE_PROJECT_CONTEXT"
```

---

## 3. DEPLOYMENTS & URLS

| Service | URL | Platform | Service ID |
|---------|-----|----------|-----------|
| website | `https://solarpro.solutions` | Vercel | project: `solarpro-v31` |
| website (old) | `https://solar-pro.app` | Vercel | same project |
| app backend | `https://site-survey-api-bpyz.onrender.com` | Render | `srv-d746gvshg0os739tqm70` |
| app mobile | React Native / Expo | EAS Build | package: `com.sitesurvey.mobile` |

---

## 4. DATABASES

### Website Database (Neon PostgreSQL)
- **Env var:** `DATABASE_URL` (set on Vercel, encrypted)
- **Host:** `ep-jolly-shadow-a8j1n17p-pooler.eastus2.azure.neon.tech`
- **Also known as:** `WEBSITE_DATABASE_URL` or `SOURCE_DATABASE_URL`
- **Owns:** `users`, `projects`, `project_physical_data`, `project_files`, `webhook_deliveries`

### App Database (Render PostgreSQL)
- **Env var:** `DATABASE_URL` (set on Render for app backend)
- **Host:** `dpg-d746qe1aae7s73bbv9e0-a.oregon-postgres.render.com`
- **DB name:** `site_survey_app`
- **Also known as:** `APP_DATABASE_URL` or `TARGET_DATABASE_URL`
- **Owns:** `surveys`, `survey_photos`, `checklist_items`, `webhook_deliveries` (app side)

### Double Database Sync — Credential Authority Rule
**The website database is the SOURCE OF TRUTH for user credentials.**  
If the app database has a user credential that doesn't match the website database, **the app database corrects itself** to match the website.

```
WEBSITE_DATABASE_URL (SOURCE_DATABASE_URL)  ← authority / source of truth
         ↓  on mismatch: app corrects itself
APP_DATABASE_URL (TARGET_DATABASE_URL)      ← corrects to match website
```

- This sync is implemented in: `partner-fresh/backend/src/services/` (James's work)
- Env vars to set when wiring this up: `WEBSITE_DATABASE_URL` on the app backend (Render), pointing to the Neon connection string

---

## 5. SHARED SECRETS — MUST MATCH ON BOTH SIDES

These values are **identical** on both Vercel (website) and Render (app). If they ever differ, the handoff flow breaks.

```
SOLARPRO_HANDOFF_SECRET=34189a35ebc1d74aca53e46e9c91e79be05c9eebf1ff52323b4d5976bf515548
SURVEY_WEBHOOK_SECRET=56185fcc8715915913ff605e14e1f3bba05bad1228a830b990819773d5a8d346
JWT_SECRET=74de2302af346e9121f13534a35a17748ad1bf79fe22fe0facd1b1a94605d657
```

---

## 6. ALL ENVIRONMENT VARIABLES

### Website (Vercel — project `solarpro-v31`)
```
DATABASE_URL                  = <Neon connection string — encrypted>
JWT_SECRET                    = 74de2302af346e9121f13534a35a17748ad1bf79fe22fe0facd1b1a94605d657
SOLARPRO_HANDOFF_SECRET       = 34189a35ebc1d74aca53e46e9c91e79be05c9eebf1ff52323b4d5976bf515548
SURVEY_WEBHOOK_SECRET         = 56185fcc8715915913ff605e14e1f3bba05bad1228a830b990819773d5a8d346
PARTNER_BASE_URL              = https://site-survey-api-bpyz.onrender.com
PARTNER_API_BEARER_TOKEN      = JWT_REDACTED_SEE_PROJECT_CONTEXT
HANDOFF_TOKEN_TTL_SECONDS     = 900
SURVEY_INGEST_DEFAULT_USER_ID = 011526da-28fc-4c01-85a0-d52c0f578fdf
NEXT_PUBLIC_BASE_URL          = https://solarpro.solutions
NEXT_PUBLIC_APP_URL           = https://solarpro.solutions
MIGRATE_SECRET                = solarpro-migrate-2024
```

### App Backend (Render — `srv-d746gvshg0os739tqm70`)
```
DATABASE_URL              = <Render Postgres — set in dashboard>
JWT_SECRET                = 74de2302af346e9121f13534a35a17748ad1bf79fe22fe0facd1b1a94605d657
SOLARPRO_HANDOFF_SECRET   = 34189a35ebc1d74aca53e46e9c91e79be05c9eebf1ff52323b4d5976bf515548
SURVEY_WEBHOOK_SECRET     = 56185fcc8715915913ff605e14e1f3bba05bad1228a830b990819773d5a8d346
SOLARPRO_WEBHOOK_URL      = https://solarpro.solutions/api/webhooks/survey-complete
ALLOWED_ORIGINS           = https://solar-pro.app,https://site-survey-api-bpyz.onrender.com
WEBSITE_DATABASE_URL      = <Neon connection string — for credential sync>
```

### PARTNER_API_BEARER_TOKEN — How to Regenerate
This is a long-lived JWT (10yr) signed with the app's `JWT_SECRET`, role=admin.
```bash
python3 -c "
import jwt, time
print(jwt.encode({
  'userId': 'solarpro-ingest-service',
  'email': 'ingest@solarpro.internal',
  'username': 'solarpro-ingest',
  'role': 'admin',
  'iat': int(time.time()),
  'exp': int(time.time()) + (10 * 365 * 24 * 3600)
}, '74de2302af346e9121f13534a35a17748ad1bf79fe22fe0facd1b1a94605d657', algorithm='HS256'))
"
```

---

## 7. DATA FLOW — SURVEY INGEST PIPELINE

```
[app — mobile]                           [app — backend (Render)]
User submits survey
  → POST /api/surveys
  → POST /:id/complete
  → enqueueSurveyCompleteWebhook()
  → HMAC-SHA256 signed POST ──────────→ webhook_deliveries (queued)
                                          processWebhookQueue()
                                               ↓
                               POST https://solarpro.solutions/api/webhooks/survey-complete
                                               ↓
[website — Next.js (Vercel)]
  verifyWebhookSignature()    ← SURVEY_WEBHOOK_SECRET
  idempotency check
  runIngestPipeline():
    A. validate owner (SURVEY_INGEST_DEFAULT_USER_ID)
    B. resolve project link (CREATE_ORPHAN / ATTACH / TRIAGE)
    C. fetchFullPayload()     ← GET app-backend/api/surveys/:id
                                 Authorization: Bearer PARTNER_API_BEARER_TOKEN
    D. transform (v1.0 transformer)
       site_name              → projectName
       site_address           → address
       latitude/longitude     → lat/lng
       metadata.rafter_spacing ('24in') → rafter_spacing_in: 24
       metadata.roof_age_years          → roof_age_years
       metadata.rafter_size + azimuth   → mounting_notes
       photos[].file_path               → full URL (PARTNER_BASE_URL + path)
    E. write to website DB:
       → projects (upsert)
       → project_physical_data (upsert)
       → project_files (insert, idempotent)
    F. mark webhook_deliveries.status = 'ingested'
```

### Handoff Flow (survey launched FROM website project)
```
website: POST /api/projects/:id/survey-handoff
  → mints HS256 JWT (SOLARPRO_HANDOFF_SECRET, 15min TTL)
  → deep link: sitesurvey://new-survey?token=<jwt>

app: GET /api/handoff/:token
  → verifies JWT
  → returns project/user claims
  → NewSurveyScreen shows "Linked to SolarPro" banner
  → survey submitted with solarpro_project_id set
  → webhook routes to correct project (no orphan)
```

### SSO Login Flow (app login with website credentials)
```
website: GET /mobile-login  (browser bridge page)
  → calls POST /api/auth/mobile-session
  → mints 10min JWT
  → redirects to sitesurvey://login?token=<jwt>

app: deep link handler in _layout.tsx
  → POST /api/users/solarpro-sso with token
  → gets app JWT back
  → user is logged in
```

---

## 8. KEY FILE MAP

### Website (`/workspace/Solarpro-git/`)
| File | Purpose |
|------|---------|
| `app/api/webhooks/survey-complete/route.ts` | Receives survey webhook, runs ingest |
| `app/api/projects/[id]/survey-handoff/route.ts` | Mints handoff JWT, returns deep link |
| `app/api/auth/mobile-session/route.ts` | Mints SSO JWT for mobile login |
| `app/mobile-login/page.tsx` | Browser bridge for SSO login |
| `lib/survey/ingest/ingestPipeline.ts` | Pipeline orchestrator (Steps A–F) |
| `lib/survey/ingest/transformLayer.ts` | v1.0 + v2.0 transformers, field mapping |
| `lib/survey/ingest/payloadFetcher.ts` | Fetches full survey from app backend |
| `lib/survey/ingest/projectLinkResolver.ts` | CREATE_ORPHAN / ATTACH / TRIAGE logic |
| `lib/survey/ingest/ownerResolver.ts` | Resolves SolarPro user from webhook claims |
| `lib/survey/envelopeValidator.ts` | Validates inbound webhook envelope shape |
| `lib/survey/verifyWebhookSignature.ts` | HMAC-SHA256 signature verification |
| `lib/siteSurvey/fromPhysicalData.ts` | DB → RawSurveyPayload bridge (read-only) |

### App Backend (`/workspace/partner-fresh/backend/src/`)
| File | Purpose |
|------|---------|
| `routes/surveys.ts` | All survey CRUD, GET /api/surveys/:id |
| `routes/users.ts` | Auth, registration, SSO verify |
| `routes/handoff.ts` | GET /api/handoff/:token — consumes JWT |
| `services/webhookService.ts` | enqueueSurveyCompleteWebhook, processWebhookQueue |
| `services/sqlServerSyncService.ts` | Optional SQL Server sync (checkpoint-based) |
| `middleware/auth.ts` | Bearer token auth middleware |
| `utils/authToken.ts` | JWT sign/verify with JWT_SECRET |

### App Mobile (`/workspace/partner-fresh/mobile/`)
| File | Purpose |
|------|---------|
| `app/_layout.tsx` | Deep link handler (sitesurvey://login, sitesurvey://new-survey) |
| `src/screens/LoginScreen.tsx` | Login UI with SSO button |
| `src/context/AuthContext.tsx` | Auth state, signInWithSolarPro() |
| `src/api/client.ts` | API client, solarproSso() |
| `app.json` | App config, scheme: "sitesurvey" |
| `eas.json` | EAS Build config (production = AAB) |

---

## 9. COMMIT & DEPLOYMENT RULES

### Before Every Commit
1. **TypeScript must compile clean:** `node_modules/.bin/tsc --noEmit`
2. **No hardcoded secrets** in source code — use env vars
3. **Test the affected endpoint** before pushing
4. **Update this README** if architecture changes

### Commit Message Format
```
type(scope): short description

- bullet: what changed and why
- bullet: what was broken before
- bullet: what test confirmed it works
```
Types: `fix`, `feat`, `refactor`, `chore`, `docs`
Scopes: `ingest`, `handoff`, `sso`, `auth`, `webhook`, `db`, `mobile`, `website`

### Deployment
- **Website:** Push to `master` on `rayobrian6/Solarpro` → Vercel auto-deploys
- **App backend:** Push to `main` on `rayobrian6/site_survey-app-1` → Render auto-deploys
- **App mobile:** Run `eas build --platform android --profile production` (must be logged in as `kilby`)

### After Deploying Website
Wait for Vercel to show `READY`:
```bash
curl -s "https://api.vercel.com/v6/deployments?projectId=solarpro-v31&limit=2" \
  -H "Authorization: Bearer vcp_REDACTED_SEE_PROJECT_CONTEXT" \
  | python3 -c "import sys,json; [print(d['state'], d['url']) for d in json.load(sys.stdin)['deployments']]"
```

---

## 10. REGRESSION RULES — NEVER BREAK THESE

### 🔴 CRITICAL — Breaking these takes the whole system down

1. **`SURVEY_WEBHOOK_SECRET` must be identical on both sides.** If the website and app have different values, all webhooks fail with 401 and no surveys ever ingest.

2. **`SOLARPRO_HANDOFF_SECRET` must be identical on both sides.** If different, all handoff JWTs fail to verify and surveyors cannot launch linked surveys.

3. **`PARTNER_API_BEARER_TOKEN` must be a valid JWT signed with the app's `JWT_SECRET`.** It is NOT a static hex string. If you change `JWT_SECRET` on the app backend, regenerate this token and update it on Vercel.

4. **The `sitesurvey://` deep link scheme must remain registered in `app.json`.** Removing it breaks SSO login and handoff launch from the website.

5. **`ON CONFLICT (user_id, survey_external_id)` in `_upsertProject`.** This unique constraint makes ingest idempotent. Do not remove it.

6. **`ON CONFLICT (project_id, external_id)` in `_insertFiles`.** Same — makes file inserts replay-safe.

### 🟡 HIGH — Breaking these causes data loss or silent failures

7. **v1.0 transformer field names are confirmed against live partner payload.** The partner sends `latitude`/`longitude` (not `lat`/`lng`) and `photos[].file_path` (not `url`). Do not rename these back.

8. **`requireAuth` middleware on `GET /api/surveys/:id`** must stay in place. The ingest service authenticates with `PARTNER_API_BEARER_TOKEN` as a JWT — not a static key.

9. **`webhook_deliveries` idempotency check** uses `event_id`. Never remove the duplicate check or you'll double-ingest surveys.

10. **`resolveIngestOwner` fallback to `SURVEY_INGEST_DEFAULT_USER_ID`** must stay. Without it, surveys submitted without a handoff token (standalone app use) have no owner and ingest fails entirely.

### 🟢 MEDIUM — Breaking these causes degraded experience

11. **`fromPhysicalData.ts` is read-only** — it only SELECTs. Never add writes to it.

12. **`physicalData: null` in degraded mode** is intentional — the pipeline continues without physical data rather than failing. Don't change this to a hard failure.

13. **`buildPhotoUrl()` in `payloadFetcher.ts`** prepends `PARTNER_BASE_URL` to `/uploads/...` paths. The v1.0 transformer also does this for `file_path`. Don't duplicate or conflict these.

---

## 11. KNOWN OPEN ISSUES

| ID | Severity | Status | Description |
|----|----------|--------|-------------|
| F-13 | MEDIUM | OPEN | `carpenterjames88@gmail.com` hardcoded as admin override in `users.ts` |
| G-04 | MEDIUM | OPEN | `fallbackSurvey.ts` HandoffClaims missing F-06 ownership fields |
| F-07 | MEDIUM | OPEN | JWT in URL query string on fallback GET route |
| F-18 | MEDIUM | OPEN | SQLite (auth) + PostgreSQL (surveys) dual storage identity split in app |

---

## 12. TESTING A WEBHOOK END-TO-END

Use this script to fire a real webhook and verify the full pipeline:

```python
import hmac, hashlib, time, json, urllib.request, uuid

SURVEY_WEBHOOK_SECRET = "56185fcc8715915913ff605e14e1f3bba05bad1228a830b990819773d5a8d346"
SOLARPRO_WEBHOOK_URL = "https://solarpro.solutions/api/webhooks/survey-complete"

survey_id = "<SURVEY_UUID_FROM_APP_DB>"
event_id = str(uuid.uuid4())
timestamp = str(int(time.time()))

payload = {
    "event": "survey.completed",
    "event_id": event_id,
    "occurred_at": "2026-04-24T21:55:46.000Z",
    "survey_id": survey_id,
    "status": "submitted",
    "project_name": "Test Survey",
    "project_id": None,
    "inspector_name": "Test",
    "site_name": "Test Site",
    "completed_at": "2026-04-24T21:55:46.000Z",
    "solarpro_user_id": None,
    "solarpro_project_id": None,
    "solarpro_email": None,
}

body = json.dumps(payload)
sig = hmac.new(SURVEY_WEBHOOK_SECRET.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()

req = urllib.request.Request(SOLARPRO_WEBHOOK_URL, data=body.encode(), headers={
    "Content-Type": "application/json",
    "X-Survey-Signature": f"sha256={sig}",
    "X-Survey-Timestamp": timestamp,
    "X-Survey-Event-Id": event_id,
}, method="POST")

with urllib.request.urlopen(req, timeout=30) as resp:
    print(json.dumps(json.loads(resp.read().decode()), indent=2))
```

**Expected success response:**
```json
{
  "reason": "INGEST_OK",
  "transformSummary": {
    "fileCount": 7,
    "hasPhysicalData": true,
    "rafterSpacingIn": 24
  }
}
```

---

## 13. DATABASE SYNC — CREDENTIAL AUTHORITY

James implemented a double-database check. The rule is:

> **The website database (Neon) is always correct for user credentials.**  
> If a user exists in both databases with mismatched credentials, the app database self-corrects to match the website database.

### Env Vars Required
```
# Set on app backend (Render):
WEBSITE_DATABASE_URL=<Neon connection string>   # source of truth
# or
SOURCE_DATABASE_URL=<Neon connection string>

# The app's own database is its existing DATABASE_URL (TARGET)
```

### Sync Logic Location
- Service file: `partner-fresh/backend/src/services/` (James's work — to be committed)
- Triggered on: user login, registration, credential mismatch detection
- Direction: **website → app only** (never app → website)

---

## 14. HOW AI AGENTS SHOULD PICK UP COMMIT CONTEXT

When starting a session on this codebase:

1. **Read this file first** (`AI-AGENT-README.md`)
2. **Read `PROJECT-CONTEXT.md`** for session history and recent changes
3. **Check git log** for recent commits: `git log --oneline -10`
4. **Check Vercel deployment state** before making website changes
5. **Never assume env vars** — verify via Vercel/Render API before trusting

### Detecting Conflicting Commits
```bash
# Before pushing, always pull first
git pull origin master

# Check if your changes conflict with remote
git diff HEAD origin/master -- <file>

# If conflict on ingest/transform files — READ THE PIPELINE DOCS IN SECTION 7
# before resolving. Field name changes have cascading effects.
```

### If Two Bots Are Working Simultaneously
- Bot A owns: website (`Solarpro-git/`) changes
- Bot B owns: app (`partner-fresh/`) changes
- **Neither bot touches the other's repo without explicit user instruction**
- Both bots must read this file at session start to avoid contradicting each other

---

*Last updated: 2026-04-25 | Updated by: AI agent session*  
*To update this file: edit `/workspace/AI-AGENT-README.md` and commit to both repos*