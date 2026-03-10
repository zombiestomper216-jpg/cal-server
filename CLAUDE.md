# CLAUDE.md — cal-server (Bromo AI Companion Backend)

## Project Overview

**cal-server** is a Node.js/Express API backend for an AI companion character named **Bromo** — a direct, masculine, emotionally present companion persona. It is not a general-purpose chatbot; it has a fixed personality, behavioral rules, and a content mode system.

- **Primary AI model used:** `gpt-4.1` (OpenAI)
- **Deployed on:** Fly.io (app name: `bromo-nsfw`, region: `ord`)
- **Database:** PostgreSQL (optional; graceful degradation if absent)
- **Module system:** ES Modules (`"type": "module"` in package.json)
- **Runtime:** Node.js 24

---

## Directory Structure

```
/home/user/cal-server/
├── index.js          # All server logic (~1200 lines) — routes, auth, chat, memory
├── prompts.js        # System prompts & personality (~927 lines) — the core of Bromo's behavior
├── memoryStore.js    # JSON-based local memory fallback (55 lines)
├── memory.json       # Local JSON storage file (for dev/fallback)
├── package.json      # Dependencies and scripts
├── Dockerfile        # Container config (exposes 3000)
├── fly.toml          # Fly.io deployment config (internal port 3000)
├── app.json          # Expo app metadata (mobile app counterpart)
├── eas.json          # Expo Application Services config
├── tsconfig.json     # TypeScript config (extends expo)
├── auth.json         # Auth configuration
└── _archived/        # Old TypeScript persona files (deprecated)
```

> **Note:** All business logic lives in `index.js`. There is no subdirectory structure for routes/controllers/services.

---

## Running the Server

```bash
# Development (with auto-restart on file change)
npm run dev

# Production
npm start
```

Server starts on `process.env.PORT` (defaults to **8080**).

> **Port mismatch:** Dockerfile and fly.toml expose port **3000**, but the server code defaults to **8080**. Ensure `PORT=3000` is set in the deployment environment.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for GPT-4 |
| `DATABASE_URL` | No | PostgreSQL connection string. App works without it. |
| `PORT` | No | Server port (defaults to 8080) |
| `TESTER_CODES` | Yes (for auth) | Comma-separated allowlist of valid tester codes |
| `TESTER_ADULT_CODES` | No | Subset of tester codes with NSFW access granted |
| `DEV_AUTH_USER` | No | Legacy dev username |
| `DEV_AUTH_PASS` | No | Legacy dev password |
| `DEV_ADULT_VERIFIED` | No | Set `true` to grant adult access to dev accounts |
| `DEBUG_CHAT` | No | Set `true` for verbose logging |

---

## API Endpoints

### Public (no auth)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check ("Bromo API is running") |
| `GET` | `/health` | Detailed health check with DB status |
| `POST` | `/auth` | Generate a session token |

### Authenticated (Bearer token required)
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Main chat endpoint — generate Bromo response |
| `POST` | `/summarize` | Summarize a conversation thread |
| `GET` | `/memories` | Retrieve stored memories for a device |
| `POST` | `/memories` | Create/upsert a memory |
| `PUT` | `/memories/:id` | Update a memory by ID |
| `DELETE` | `/memories/:id` | Delete a memory by ID |
| `POST` | `/detect-memory` | Analyze messages for extractable facts (heuristic) |

---

## Authentication Flow

1. Client POSTs to `/auth` with `{ code: "TESTER_CODE" }` (or legacy username/password)
2. Server validates code against `TESTER_CODES` env var
3. Returns `{ ok: true, token: "tester:CODE.timestamp.random", adultVerified: bool }`
4. All subsequent requests include `Authorization: Bearer <token>`

**Token format:**
- Tester: `tester:CODE.{timestamp}.{random}`
- Dev: `dev.{timestamp}.{random}`

Tokens are **not cryptographically signed** — trust is based on allowlists.

---

## Content Mode System

Bromo has two content modes and a pace/drift system:

### Modes
- **SFW** — Safe-for-work; all users
- **NSFW** — Adult content; requires `adultVerified` flag on token

### Pace Levels (mapped from `driftSpeed` or string)
| Input | Pace | Temperature |
|-------|------|-------------|
| `1` / `SLOW_BURN` | `SLOW_BURN` | 0.7 |
| `5` / `TURN_IT_UP` | `TURN_IT_UP` | 0.9 |
| `9` / `AFTER_DARK` | `AFTER_DARK` | 0.95 |
| default | `NORMAL` | 0.85 (NSFW) / 0.7 (SFW) |

Temperature for summarize is fixed at **0.3**.

---

## Database Schema

### `memories` table
```sql
CREATE TABLE memories (
  id          SERIAL PRIMARY KEY,
  device_id   VARCHAR NOT NULL,
  key         VARCHAR NOT NULL,
  value       TEXT,
  mode        VARCHAR,        -- 'SFW', 'NSFW', or NULL
  confidence  VARCHAR,        -- 'high' (user-confirmed) or 'low' (heuristic)
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (device_id, key)
);
```

### `chat_runs` table (audit log)
```sql
CREATE TABLE chat_runs (
  id           SERIAL PRIMARY KEY,
  mode         VARCHAR,
  pace         VARCHAR,
  model        VARCHAR,
  temperature  FLOAT,
  user_text    TEXT,
  reply_text   TEXT,
  created_at   TIMESTAMP DEFAULT NOW()
);
```

Database inserts are **best-effort** — failures are logged but never crash the server.

---

## Memory System

Memories are keyed facts about a user, stored per `device_id`.

- **High confidence** = user explicitly confirmed the memory
- **Low confidence** = heuristically detected, awaiting confirmation
- Only `high` confidence memories are injected into chat context
- Up to **50 memories** per chat context (sorted by recency)
- Mode-aware: SFW memories don't bleed into NSFW context and vice versa

### Memory Detection (`/detect-memory`)
Uses regex patterns (no ML) to detect:
- **preferences:** "I like...", "I'm into...", "I'm a fan of..."
- **dislikes:** "I hate...", "I can't stand..."
- **identity:** "My name is...", "Call me...", "I'm a [profession]..."
- **activities:** "I'm working on...", "I'm building..."
- **boundaries:** "Never call me...", "Don't mention...", "I have a boundary around..."

Filters out: emotional states (tired, stressed, horny), roleplay/hypotheticals, captures >80 chars.
Returns max **3 suggestions** per call. Client decides which to confirm/store.

---

## Key Architectural Patterns

### 1. Prompt-Driven Personality
All of Bromo's behavior is defined in `prompts.js`. The system prompt is assembled by `buildSystemPrompt()` from:
- Core identity block
- Mode-specific prompt (SFW/NSFW)
- Memory injection (up to 50 memories)
- Optional NSFW behavior patch for aggressive paces

### 2. Hard Taboo Enforcement
Before calling OpenAI, `violatesHardTaboo()` checks for and blocks:
- Incest/step-family content
- Minors in sexual contexts
- Non-consent framing ("no means yes", etc.)

Returns a `blocked: true` response without calling the API.

### 3. Early Response Guard
`softenEarlySnap()` post-processes the first 1-2 responses, replacing curt phrases like "What do you want?" with warmer alternatives like "Yeah. I'm here."

### 4. Graceful Degradation
- No database? App runs with local JSON fallback (`memory.json`)
- Memory detection skipped? Chat still works
- OpenAI insert failure? Warning logged, response still returned

### 5. Stateless but Gated
Server holds no session state. All context (messages, memories, thread summaries) is sent by the client on each request. Auth is validated by allowlist lookup, not database session.

---

## Prompts.js — Key Exports

| Export | Description |
|--------|-------------|
| `coreSFW` | Bromo's baseline identity and SFW behavior rules |
| `sfwPacePatches` | Pace-specific overlays for SFW mode |
| `nsfwBase` | NSFW mode base prompt |
| `nsfwBehaviorPatch` | Overlay for aggressive paces (TURN_IT_UP, AFTER_DARK) |
| `summarizePrompt` | Prompt for conversation summarization |
| `detectMemoryPrompt` | (If used) Memory extraction prompt |

---

## Development Notes

### No Test Suite
There are no automated tests. Testing is manual via API calls. Enable `DEBUG_CHAT=true` for verbose logging.

### Phase Numbering Convention
Commits reference "Phase N" (e.g., Phase 11.6). This is an internal versioning system for prompt/behavior iterations.

### Port Issue to Fix
Dockerfile/fly.toml use port **3000**, server code defaults to **8080**. Always set `PORT=3000` in deployment.

### `_archived/` Directory
Contains old TypeScript persona files. Not imported anywhere. Safe to ignore.

### Rate Limiting
`express-rate-limit` is installed but not applied to any routes. Consider adding before production scaling.

### Token Security
Current token scheme is not cryptographically signed. If security tightens, consider HMAC-signed tokens or JWT with a secret.

---

## Common Tasks

### Add a new route
Add directly to `index.js`. Follow the existing pattern:
```javascript
app.post('/my-route', requireAuth, async (req, res) => {
  // ...
  res.json({ ok: true, ... });
});
```

### Update Bromo's personality
Edit `prompts.js`. Exports are imported in `index.js` via `buildSystemPrompt()`.

### Add a memory category
Edit `detectMemoriesHeuristic()` in `index.js` — add a new entry to the `patterns` array with `category`, `regex`, and `key` prefix.

### Change the AI model
Search for `gpt-4.1` in `index.js` and update the model string. It appears in both `/chat` and `/summarize` endpoints.

---

## Deployment

```bash
# Deploy to Fly.io
fly deploy

# View logs
fly logs -a bromo-nsfw

# SSH into machine
fly ssh console -a bromo-nsfw
```

Docker build:
```bash
docker build -t cal-server .
docker run -p 3000:3000 --env-file .env cal-server
```
