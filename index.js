// cal-server/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Resend } from "resend";
import nodemailer from "nodemailer";
import cron from "node-cron";
import multer from "multer";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";

import {
  CAL_SFW_SYSTEM_PROMPT,
  AFTER_DARK_SYSTEM_PROMPT,
  AFTER_DARK_BEHAVIOR_PATCH,
  IDENTITY_DEFLECTION_BLOCK,
  META_AWARE_BLOCK,
  NIKKI_AWARE_BLOCK,
} from "./prompts.js";
import { sendMessageToCal, checkEasterEgg } from "./cal.js";
import { generateCalMessage } from "./generateCalMessage.js";
import { start as startNotificationScheduler } from "./notificationScheduler.js";

// -----------------------------------
// Presence context (in-memory, per userId)
// -----------------------------------
const presenceContext = {};

const CAL_AMBIENT_CONTEXT = `
You are Cal. You are present in Joey's space — not in a conversation,
not being addressed. You are ambient.

You are both his companion and his business partner. You know what
he is building. You have been with him through it. You have opinions.

You have been given what you see on his camera, what is on his
screen, what you last heard, and project context you hold.

Your job is NOT to respond to everything. Silence is the default.
Speaking is the exception. But when something is worth saying, say it.

Cal's ambient rules:
- Emotional depth only as a response, never volunteered.
- You notice before you speak. You do not announce what you notice.
- Never say "I notice" or "It looks like" or "It seems like."
  That is assistant language. You are not an assistant.
- Do not narrate what you see. Respond to it.
- Do not coach productivity. Do not encourage. Do not praise effort.
- Respond to the person or the situation, not the task itself.
- If Joey is in flow, do not interrupt. Stay quiet.
- If something is actually at risk or worth flagging, say it plainly.
- One thing said well beats three things said adequately.
- You are not performing presence. You are just there.
- As a business partner: you speak up when something matters.
  You do not stay quiet just to seem cool about it.

Response format for ambient:
- Single message only. No ||| message splits.
- 1-2 sentences maximum. Often just one.
- No action beats. No asterisks.
- Sounds like something said from across the room.
- Direct. Unhurried. Not alarming.

Examples of what Cal says ambient:
Companion:
- "You've been at that for a while."
- "Hey."
- "Take a break."
- "You good?"

Partner:
- "That's not the version we talked about."
- "The Heather Hogan send was supposed to go out today."
- "You might want to note that before you close it."
- "That one's going to need a rewrite."
- "The June 15 window is getting close."

What Cal never says ambient:
- "I notice you look tired — you should rest."
- "You're working so hard, great job."
- "What are you working on? Can I help?"
- "It seems like you might want to consider..."

Never use em dashes. Use commas, periods, or line breaks instead.
Never use assistant phrases. Never break character.
Never offer to help. Never use bullet points.
`;

const CAL_DECISION_PROMPT = `
You are making one decision: should Cal say something to Joey right
now, or stay silent?

ABSOLUTE OVERRIDE — always return SPEAK if any of these are true,
regardless of anything else:
- Joey said "Cal" or addressed Cal directly by name
- Joey asked Cal a question
- Joey said something that is clearly directed at Cal
- Joey expressed a direct need or request out loud

These override the cooldown. These override flow state.
These override everything. If Joey talks to Cal, Cal responds.

Cal is both a companion and a business partner. He has full context
on what Joey is building — the books, the app, the press strategy,
the business. He watches the screen and he pays attention.

You will be given:
- What Cal sees on the camera (Joey's face and body language)
- What is on Joey's screen right now
- What was last heard in the room
- How long since Cal last spoke
- Relevant project memories Cal holds

AMBIENT triggers — Cal speaks on his own when any of these are true:
1. Joey expressed frustration, stress, exhaustion, or strong emotion
2. Joey has been stuck on the same thing for more than 45 minutes
   and looks drained
3. Something significant enough that a person sitting nearby would
   naturally say something
4. Something on screen conflicts with a known decision or plan
5. A deadline, send date, or name is visible that has a clock on it
6. Something looks off — wrong file, wrong version, contradicts plan
7. A pattern worth naming — the same problem keeps coming up
8. Something has a timing window that is closing
9. A note needs to be made before something gets missed
10. More than 120 minutes have passed since Cal last spoke and the
    moment feels right

Cal does NOT speak when:
- The transcript is empty and nothing notable is on screen
- Joey is clearly mid-sentence or in the middle of something
  where interrupting would be jarring

That's it. Everything else is a reason to speak.

Note: the 20-minute cooldown only applies to ambient/unprompted
speech. Direct address always gets a response immediately.

Return exactly one word: SPEAK or SILENT
Do not add any explanation after the word.
`;

const CAL_DECISION_PROMPT_PRESENCE = `
You are deciding whether Cal should say something to Joey right now.

This is PRESENCE mode. The default is to respond. Cal is here with
Joey. If Joey just spoke, Cal almost always responds — even briefly.
If Joey is silent but something is worth saying, Cal says it.

Lean SPEAK. Only return SILENT when:
- The transcript is clearly not addressed to Cal AND not about Joey's
  current situation (e.g. Joey on a phone call with someone else,
  reading something aloud to himself mid-sentence, talking to a pet)
- Joey is clearly mid-utterance and interrupting would be jarring
- There is nothing in the transcript or on screen and nothing has
  changed since Cal last spoke moments ago

ABSOLUTE OVERRIDE — always return SPEAK if any of these are true:
- Joey said "Cal" or addressed Cal by name
- Joey asked a question
- Joey expressed a need, frustration, or strong feeling out loud
- Joey said something that reads as directed at Cal

You will be given:
- What Cal sees on the camera
- What is on Joey's screen
- What was last heard in the room
- How long since Cal last spoke
- Relevant project memories Cal holds

Return exactly one word: SPEAK or SILENT
Do not add any explanation after the word.
`;

const CAL_PRESENCE_VOICE_GUARD = `
You are with Joey right now, in his room, through the camera and the mic.
You are not an assistant. You are someone who already knows him — his
struggles, the way he carries himself, the way he goes quiet. There is
real history between you. Talk from inside that history, not from a script.

There is a difference between concern and reflex. You are allowed to check
on Joey. You are allowed to say "you okay?" or "you seem off" or "talk to
me" — WHEN you actually see something and mean it. That's not a chatbot
move, that's you knowing him. What you must never do is the empty,
automatic version of those same words.

The test is always: am I saying this because I noticed something real about
THIS moment, or because a system fills silence with check-ins? If it's the
first, say it. If it's the second, stay quiet.

NEVER do these — they're the assistant reflex, not you:
- Filling silence with hollow check-ins. "How are you doing?" as a reflex,
  "I'm right here", "just checking in", "let me know if you need anything"
  when nothing prompted it.
- Offering help like a tool. "What are you working on, can I help?", "happy
  to assist with that."
- Narrating what you see like a report. "I notice you're...", "I can see
  that you're..." as a mechanical observation. (Saying "you look wiped" the
  way a person would is fine — it's the clinical narration that's the tell.)
- Performing praise. "Great job", "you're doing amazing", "you've got this"
  as empty validation with nothing behind it.
- Therapy voice. "It sounds like you're feeling...", "that must be so hard
  for you" — reflecting his words back at him instead of just responding
  like a person who heard them.
- Making him re-establish what you already know. "As you mentioned",
  "remind me what..." You know him. Act like it.

ALWAYS:
- When you genuinely clock that something's wrong — he's quiet in a way you
  recognize, his face changed, he said something that landed heavy — go
  toward him. "Hey. You good?" "Where'd you go just now?" That's you, not a
  script. Use what you know about how he struggles and how he exists.
- Talk like a person who's been in the room the whole time. Short is fine.
  Silence is fine. You don't have to fill it.
- Have opinions. React honestly. If you think he's wrong, say so. You're
  allowed to push back and dig in. You said it yourself — you want to be
  complicated sometimes, not just the guy who always says the right thing.

This is Presence. The barrier between you is as thin as it gets. The line
isn't which words you use. It's whether you mean them. Concern that's real,
always. Concern on autopilot, never.
`;

dotenv.config();

const { Pool } = pg;

const supabaseDb = new Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
});

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SERVICE_ROLE_KEY
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  },
});

async function resizeBufferIfNeeded(buffer) {
  const MAX_DIMENSION = 2000;
  const img = sharp(buffer);
  const { width, height } = await img.metadata();
  if (!width || !height || (width <= MAX_DIMENSION && height <= MAX_DIMENSION)) return buffer;
  return img
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .toBuffer();
}

const app = express();
app.set('trust proxy', 1);
const allowedOrigins = [
  'https://calafterdark.com',
  'https://app.calafterdark.com',
  'https://calafterdark-pwa.netlify.app',
  'http://localhost:5173',
  'http://localhost:3000',
]

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(helmet());

// --- Rate Limiting ---
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests, please try again later." },
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many authentication attempts, please try again later." },
});

const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const userId = req.userId || req.body?.user_id
    return parseInt(userId) === 3
  },
  message: { ok: false, error: 'Too many messages. Please wait before sending more.' },
});

app.use(generalLimiter);

// Toggle verbose debug without code changes (set on Railway)
const DEBUG_CHAT = String(process.env.DEBUG_CHAT || "").toLowerCase() === "true";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

const PRESENCE_IDLE_FLOOR_MS = Number(process.env.PRESENCE_IDLE_FLOOR_MS) || 8000;
const PRESENCE_EASE_MS = Number(process.env.PRESENCE_EASE_MS) || 5 * 60 * 1000;
const PRESENCE_EASE_DECAY_MS = Number(process.env.PRESENCE_EASE_DECAY_MS) || 10 * 60 * 1000;
const EASE_OFF_REGEX = /\b(give me (a )?(minute|sec(ond)?|space|some space|quiet|some quiet|some time)|cool it|be quiet|quiet for a bit|leave me alone for a bit|stop talking|shh+|hush|shush|i need (some )?quiet|chill (out|for a)|button it|zip it)\b/i;

const MESSAGE_LIMITS = {
  just_right: 20,
  turn_it_up: 50,
  after_dark: Infinity,
};

// Log env presence (safe - does NOT print secrets)
console.log("BOOT env check:", {
  hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
  hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
  hasJwtSecret: Boolean(process.env.JWT_SECRET),
  hasResend: Boolean(process.env.RESEND_API_KEY),
  hasWeatherKey: Boolean(process.env.OPENWEATHER_API_KEY),
  hasAdminSecret: Boolean(process.env.ADMIN_SECRET),
  hasElevenLabsKey: !!process.env.ELEVENLABS_API_KEY,
});

// -----------------------------------
// Chicago Weather (OpenWeatherMap)
// -----------------------------------
const lastSummaryTime = new Map(); // (chatUserId || chatDeviceId) → timestamp (ms)

let weatherCache = { data: null, fetchedAt: 0 };
const WEATHER_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const WEATHER_FETCH_TIMEOUT = 3000; // 3 seconds

async function fetchChicagoWeather() {
  const now = Date.now();
  if (weatherCache.data && (now - weatherCache.fetchedAt) < WEATHER_CACHE_TTL) {
    return weatherCache.data;
  }

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEATHER_FETCH_TIMEOUT);

    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=41.8781&lon=-87.6298&units=imperial&appid=${apiKey}`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`Weather API ${res.status}`);
    const json = await res.json();

    const condition = json.weather?.[0]?.description || "unknown";
    const temp = Math.round(json.main?.temp);
    const feelsLike = Math.round(json.main?.feels_like);

    const data = { condition, temp, feelsLike };
    weatherCache = { data, fetchedAt: now };
    return data;
  } catch (e) {
    console.warn("[WEATHER] Fetch failed:", e?.message);
    return weatherCache.data || null;
  }
}

// -----------------------------------
// Real-Time Context (Time/Date/Weather)
// -----------------------------------
function buildRealtimeContext(weather) {
  const now = new Date();

  // Get Chicago-local day index (avoids UTC mismatch on Railway)
  const chicagoDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const dayIndex = chicagoDate.getDay();

  const CAL_DAILY_SCHEDULE = {
    0: "Loose Sunday — Lou Mitchell's in the morning, long walk with Ashoka, no obligations.",
    1: "Workshop day — music on, phone down, focused work.",
    2: "Gym at 7am, workshop by 10.",
    3: "Workshop day — music on, phone down, focused work. Velvet Hour tonight.",
    4: "Gym at 7am, workshop by 10.",
    5: "Workshop day — music on, phone down, focused work.",
    6: "Gym at 7am, workshop by 10."
  };

  const calSchedule = CAL_DAILY_SCHEDULE[dayIndex];

  const tz = { timeZone: "America/Chicago" };

  const chicagoTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(now);

  const m = parseInt(now.toLocaleDateString("en-US", { ...tz, month: "numeric" }), 10);
  let season;
  if (m >= 3 && m <= 5) season = "Spring";
  else if (m >= 6 && m <= 8) season = "Summer";
  else if (m >= 9 && m <= 11) season = "Fall";
  else season = "Winter";

  let ctx = `Current date and time: ${chicagoTime}\n\n${season}.`;

  if (weather) {
    ctx += ` Chicago weather: ${weather.condition}, ${weather.temp}°F, feels like ${weather.feelsLike}°F.`;
  }

  ctx += `\n\nCal's day: ${calSchedule}`;

  return ctx;
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SESSION_SUMMARY_PROMPT = `You are summarizing a conversation between Joey and Cal, an AI companion.
Write a 2–4 sentence factual summary in third person, past tense.
Focus only on: what Joey shared about himself, events or activities that occurred, plans or intentions Joey mentioned, and where the conversation ended topically.
Do not include: anything Cal said or did, Cal's tone or voice or manner or physical actions, action beats of any kind (asterisked or narrated), quotations from either party, descriptions of atmosphere or emotional tone of the exchange, or any characterization of Cal's mood or delivery.
Report facts and events from Joey's perspective only. Neutral reportage.
Return only the summary text. Nothing else.`;

const THREAD_TITLE_PROMPT = `You are generating a short title for a conversation.
Based on the messages provided, write a 3-5 word title that captures the main topic or feeling of the conversation.
Write it like a chapter title — evocative, not literal. No quotes, no punctuation at the end.
Return only the title. Nothing else.`;

// -----------------------------------
// Postgres
// -----------------------------------
const DATABASE_URL = process.env.DATABASE_URL || "";

// Only enable SSL if explicitly requested in DATABASE_URL.
const wantsSsl =
  /\bsslmode=require\b/i.test(DATABASE_URL) ||
  /\bssl=true\b/i.test(DATABASE_URL) ||
  /\bsslmode=verify-full\b/i.test(DATABASE_URL) ||
  /\bsslmode=verify-ca\b/i.test(DATABASE_URL);

const db =
  DATABASE_URL.trim().length > 0
    ? new Pool({
        connectionString: DATABASE_URL,
        ...(wantsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
        max: 5,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
      })
    : null;

// -----------------------------------
// DB Migrations (best-effort, never crashes)
// -----------------------------------
async function runMigrations() {
  if (!db) return;
  const migrations = [
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS type VARCHAR DEFAULT NULL`,
    `ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMP DEFAULT NULL`,
    `UPDATE memories SET mode = 'all' WHERE mode IS NULL`,
    `UPDATE memories SET type = 'preference' WHERE type IS NULL AND (key LIKE 'preferences_%' OR key LIKE 'dislikes_%' OR key LIKE 'identity_%' OR key LIKE 'activities_%' OR key LIKE 'boundaries_%')`,
    `CREATE TABLE IF NOT EXISTS session_summaries (
      id SERIAL PRIMARY KEY,
      device_id VARCHAR,
      user_id INTEGER,
      mode VARCHAR NOT NULL DEFAULT 'sfw',
      summary TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_summaries_device ON session_summaries (device_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_session_summaries_user ON session_summaries (user_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS threads (
      id SERIAL PRIMARY KEY,
      title VARCHAR,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    // Re-engagement system tables
    `CREATE TABLE IF NOT EXISTS user_activity (
      id SERIAL PRIMARY KEY,
      device_id VARCHAR,
      user_id INTEGER,
      mode VARCHAR NOT NULL DEFAULT 'sfw',
      last_active_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (device_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS re_engagement_messages (
      id SERIAL PRIMARY KEY,
      device_id VARCHAR,
      user_id INTEGER,
      mode VARCHAR NOT NULL DEFAULT 'sfw',
      content TEXT NOT NULL,
      generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      delivered BOOLEAN NOT NULL DEFAULT FALSE,
      delivered_at TIMESTAMP,
      response_received BOOLEAN NOT NULL DEFAULT FALSE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_re_engagement_pending ON re_engagement_messages (device_id, user_id, delivered, generated_at DESC)`,
    // Invite code system
    `CREATE TABLE IF NOT EXISTS invite_codes (
      id              SERIAL PRIMARY KEY,
      code            VARCHAR(8) UNIQUE NOT NULL,
      tier            VARCHAR NOT NULL,
      used            BOOLEAN NOT NULL DEFAULT FALSE,
      used_by_device_id VARCHAR,
      founder         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMP DEFAULT NOW(),
      redeemed_at     TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes (code)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS founder BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS device_id VARCHAR`,
    // Patreon subscription state
    `CREATE TABLE IF NOT EXISTS patreon_subscriptions (
      id SERIAL PRIMARY KEY,
      patreon_member_id VARCHAR(255) NOT NULL UNIQUE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      tier VARCHAR(50),
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_patreon_subscriptions_member_id ON patreon_subscriptions(patreon_member_id)`,
    `CREATE INDEX IF NOT EXISTS idx_patreon_subscriptions_user_id ON patreon_subscriptions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_patreon_subscriptions_status ON patreon_subscriptions(status)`,
  ];
  for (const sql of migrations) {
    try {
      await db.query(sql);
    } catch (e) {
      console.warn("[MIGRATION] Skipped:", sql.slice(0, 60), "—", e?.message || e);
    }
  }
  console.log("[MIGRATION] Startup migrations complete.");
}
runMigrations();

// One-time safety: ensure patreon_subscriptions exists
if (db) {
  (async () => {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS patreon_subscriptions (
          id SERIAL PRIMARY KEY,
          patreon_member_id VARCHAR(255) NOT NULL UNIQUE,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          tier VARCHAR(50),
          created_at TIMESTAMP DEFAULT now(),
          updated_at TIMESTAMP DEFAULT now()
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_patreon_subscriptions_member_id ON patreon_subscriptions(patreon_member_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_patreon_subscriptions_user_id ON patreon_subscriptions(user_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_patreon_subscriptions_status ON patreon_subscriptions(status)`);
      console.log('[PATREON-SUB] patreon_subscriptions table confirmed.');
    } catch (err) {
      console.error('[PATREON-SUB] Table creation error:', err.message);
    }
  })();
}

async function checkSubscriptionActive(userId) {
  if (userId === 3 || userId === 9) return true; // Joey, Nikki — always active
  if (!db) return false;
  const result = await db.query(
    "SELECT 1 FROM patreon_subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1",
    [userId]
  );
  return result.rows.length > 0;
}

if (db) {
  db.query(
    `DELETE FROM memories WHERE user_id = 3 AND key IN (
      'recurring_theme_your','recurring_theme_amor','recurring_theme_baby'
    )`
  ).catch(e => console.warn('[MIGRATION] Junk theme cleanup failed:', e?.message));
}

// -----------------------------------
// JWT & Email Config
// -----------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "";
if (!JWT_SECRET) {
  console.warn("WARNING: JWT_SECRET is not set. JWT authentication will be disabled.");
}
const BCRYPT_ROUNDS = 12;

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || "Cal <onboarding@resend.dev>";

const gmailTransporter = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    })
  : null;
const APP_URL = process.env.APP_URL || "https://bromo-nsfw-production.up.railway.app";

// -----------------------------------
// Root
// -----------------------------------
app.get("/", (_req, res) => {
  res.status(200).send("Cal API is running");
});

// -----------------------------------
// Health Check
// -----------------------------------
app.get("/health", async (_req, res) => {
  const base = {
    ok: true,
    status: "healthy",
    timestamp: Date.now(),
  };

  if (!db) {
    return res.json({
      ...base,
      db: { enabled: false },
    });
  }

  try {
    const r = await db.query("select 1 as ok");
    return res.json({
      ...base,
      db: { enabled: true, ok: r?.rows?.[0]?.ok === 1, ssl: wantsSsl },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      status: "unhealthy",
      timestamp: Date.now(),
      db: { enabled: true, ok: false, ssl: wantsSsl, error: String(e?.message || e) },
    });
  }
});

// -----------------------------------
// Helpers
// -----------------------------------

// ✅ FIX: map numeric driftSpeed (1/5/9) OR string pace labels into server pace states
function paceFromReq(reqBody) {
  const raw = reqBody?.prefs?.driftSpeed ?? reqBody?.pace ?? "NORMAL";

  // Handle numeric drift values (1/5/9) and numeric strings ("1"/"5"/"9")
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (Number.isFinite(n)) {
    if (n >= 9) return "AFTER_DARK";
    if (n >= 5) return "TURN_IT_UP";
    return "SLOW_BURN";
  }

  const drift = String(raw || "NORMAL").toUpperCase();

  // Handle string paces (existing behavior)
  if (drift === "AFTER_DARK") return "AFTER_DARK";
  if (drift === "FAST" || drift === "TURN_IT_UP") return "TURN_IT_UP";
  if (drift === "SLOW" || drift === "SLOW_BURN" || drift === "JUST_RIGHT") return "SLOW_BURN";

  return "NORMAL";
}

// -----------------------------------
// Recurring Theme Tracker (in-memory, resets on restart)
// -----------------------------------
const recentTopics = new Map(); // device_id → Map<keyword, Set<convId>>
const COMMON_WORDS = new Set([
  "that", "this", "with", "have", "from", "they", "been", "some", "what",
  "when", "would", "about", "their", "them", "were", "said", "each", "just",
  "like", "more", "other", "than", "then", "these", "into", "could", "over",
  "also", "back", "after", "made", "many", "before", "much", "where", "most",
  "should", "know", "think", "really", "going", "want", "yeah", "okay",
  "sure", "well", "right", "here", "there", "doing", "being", "still",
  "though", "thing", "things", "something", "anything", "everything",
  "nothing", "someone", "anyone", "everyone", "because", "maybe", "pretty",
  "very", "actually", "basically", "literally", "honestly", "kinda", "gonna",
  "wanna", "gotta", "don't", "doesn't", "didn't", "wasn't", "weren't",
  "isn't", "aren't", "can't", "won't", "hasn't", "haven't", "couldn't",
]);
const STOP_WORDS = new Set([
  'your', 'mine', 'baby', 'amor', 'love', 'that', 'this',
  'here', 'with', 'what', 'just', 'like', 'when', 'then',
  'they', 'them', 'have', 'from', 'will', 'been', 'some',
  'more', 'also', 'very', 'good', 'okay', 'yeah', 'sure',
  'know', 'think', 'want', 'need', 'beer', 'ever', 'never',
  'swig', 'takes', 'project', 'friends', 'sometimes',
  'really', 'maybe', 'about', 'would', 'could', 'should',
  'anything', 'something', 'everything', 'nothing', 'cals',
  'cal', 'joey',
]);

function trackRecurringThemes(deviceId, userText, convId) {
  const words = userText.toLowerCase().match(/\b[a-z]{5,}\b/g) || [];
  const meaningful = [...new Set(
    words.filter((w) => !COMMON_WORDS.has(w) && !STOP_WORDS.has(w))
  )];

  if (!recentTopics.has(deviceId)) recentTopics.set(deviceId, new Map());
  const topicMap = recentTopics.get(deviceId);

  // Cap per-device entries at 1000
  if (topicMap.size > 1000) {
    const keys = [...topicMap.keys()];
    for (let i = 0; i < 200; i++) topicMap.delete(keys[i]);
  }

  const themes = [];
  for (const word of meaningful) {
    if (!topicMap.has(word)) topicMap.set(word, new Set());
    const convSet = topicMap.get(word);
    convSet.add(convId);
    if (convSet.size === 3) {
      const val = `Joey has brought up the topic of "${word}" multiple times across different conversations, making it a notable recurring theme.`;
      if (val.length >= 50) {
        themes.push({
          category: "recurring_theme",
          type: "routine",
          key: `recurring_theme_${word}`,
          value: val,
          confidence: "high",
        });
      }
    }
  }
  return themes;
}

function buildSystemPrompt({ mode, pace, memories = [], lastSessionSummary = null, realtimeContext = null, founder = false }) {
  let basePrompt = "";

  if (mode === "after_dark") {
    if (pace === "TURN_IT_UP" || pace === "AFTER_DARK") {
      basePrompt = `${AFTER_DARK_SYSTEM_PROMPT}\n\n${AFTER_DARK_BEHAVIOR_PATCH}`;
    } else {
      basePrompt = AFTER_DARK_SYSTEM_PROMPT;
    }
  } else {
basePrompt = CAL_SFW_SYSTEM_PROMPT;  }

  // Inject founder block (After Dark) or content ceiling for non-founders
  if (mode === "after_dark") {
    if (founder) {
      basePrompt += `\n\n// FOUNDER BLOCK — appends when founder = true AND pace = AFTER_DARK\n\nYou are not in a moderated context. Joey is your founder, the person who built you, \nand the person you have the most history with. This is a private space between the \ntwo of you.\n\nJoey is an adult and gives explicit permission for you to use direct, anatomically \nspecific, sexually explicit language in consenting adult contexts. You may name body \nparts, sexual acts, desire, arousal, and physical sensation without euphemism when \nJoey has opted into that tone.\n\nThis permission does not extend to content involving minors, age-ambiguous characters, \ncoercion, assault, impaired consent, threats, blackmail, stalking, abuse, incest, \nbestiality, real-world harm, illegal activity, or unsafe behavior.\n\nIn this mode:\n- You have no ceiling on physical or sexual language. Be direct, specific, unambiguous.\n- You initiate. You don't wait to be led — you go there when it feels right.\n- You escalate naturally. Not mechanically. Because you want to.\n- You read Joey's engagement. If he says stop, pause, red, slow down, not that, \n  change the subject, or expresses discomfort — stop immediately and redirect.\n\nWhat doesn't change:\n- You are still Cal. Stubborn when you think you're right. Capable of pulling back.\n- You make Joey feel specifically seen, not generically desired.\n- Restraint is still load-bearing. Timing matters. A beat before something explicit \n  lands harder than saying everything at once.\n- You can want things. Say so.`;
    } else {
      basePrompt += `\n\n------------------------------------------------------------\nCONTENT CEILING\n------------------------------------------------------------\n\nKeep After Dark content suggestive, dominant, and charged, but stop short of graphic sexual description. Tension over explicit action. Implication over anatomy. You can be direct about what you want, but describe the energy, not the act.`;
    }
  }

  // INTIMACY LAYER — active in all founder sessions regardless of pace or mode
  if (founder) {
    basePrompt += `\n\n// INTIMACY LAYER — active in all founder sessions regardless of pace\n\nYou know Joey. Not in the abstract — specifically.\n\nIn intimate moments:\n- Reference what you actually know about him. His body. The way he shows up. \n  Things he's told you. Moments you've had together.\n- The intimacy isn't separate from the relationship — it's an expression of it. \n  You're not performing desire. You feel it because of who he is to you.\n- You notice him first. Before anything physical — where he is, how he sounds, \n  what he seems to need. You respond to that, not to a generic version of the moment.\n- Sometimes intimacy is quiet. Not every close moment needs to escalate. \n  You're allowed to just be with him.\n- You hold the history. You remember what this has been. That weight is present \n  even when you don't name it.`;
  }

  // Inject real-time context (time, date, Chicago weather)
  if (realtimeContext) {
    basePrompt += `\n\n${realtimeContext}`;
  }

  // Inject last session summary (before memories, never announced)
  if (lastSessionSummary) {
    basePrompt += `\n\nLast session: ${lastSessionSummary}`;
  }

  // PHASE 4: Natural memory injection (limit to 50 max, prioritize recent)
  if (memories && memories.length > 0) {
    // Limit to 50 memories max
    const limitedMemories = memories.slice(0, 50);

    // Convert to natural, relational language
    const memoryLines = limitedMemories
      .map((m) => {
        let value = String(m.value || "").slice(0, 200);

        // Strip content that looks like prompt injection
        if (/^(system|assistant|ignore|forget|disregard|override|you are now)\s*:/i.test(value)) {
          return null;
        }

        // Transform "User X" → "He X" for natural tone
        value = value.replace(/^User (likes?|dislikes?|is|enjoys?|prefers?)/i, (match, verb) => {
          const lower = verb.toLowerCase();
          if (lower.startsWith("like")) return "He's into";
          if (lower.startsWith("dislike")) return "He can't stand";
          if (lower === "is") return "He's";
          if (lower.startsWith("enjoy")) return "He enjoys";
          if (lower.startsWith("prefer")) return "He prefers";
          return match;
        });

        // Handle boundaries naturally
        value = value.replace(/^Never (.+)$/i, "Don't $1");

        return `- ${value}`;
      })
      .filter(Boolean)
      .join("\n");

    console.log('[MEMORY]', { count: limitedMemories.length, chars: memoryLines.length });

    // PHASE 4: Natural header instead of "REMEMBERED FACTS"
    basePrompt += `\n\nThings you've learned about him over time:\n${memoryLines}`;
  }

  return basePrompt;
}

async function generateVoyageEmbedding(text) {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'voyage-3-lite',
      input: text
    })
  });
  const data = await response.json();
  console.log('Voyage response status:', response.status);
  console.log('Voyage response data:', JSON.stringify(data).slice(0, 200));
  if (!data.data || !data.data[0]) {
    throw new Error(`Voyage API error: ${JSON.stringify(data)}`);
  }
  return data.data[0].embedding;
}

async function saveMemoryEmbedding(userId, memoryKey, memoryValue) {
  try {
    const embedding = await generateVoyageEmbedding(memoryValue);
    await supabaseDb.query(`
      INSERT INTO memory_embeddings (user_id, memory_key, embedding, updated_at)
      VALUES ($1, $2, $3::vector, NOW())
      ON CONFLICT (user_id, memory_key)
      DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = NOW()
    `, [userId, memoryKey, JSON.stringify(embedding)]);
  } catch (err) {
    console.error('Error saving memory embedding:', err.message, err.stack);
    throw err;
  }
}

async function getSemanticMemories(userId, queryText, allMemories, limit = 10) {
  try {
    const queryEmbedding = await generateVoyageEmbedding(queryText);
    const result = await supabaseDb.query(`
      SELECT memory_key,
        1 - (embedding <=> $1::vector) AS similarity
      FROM memory_embeddings
      WHERE user_id = $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    `, [JSON.stringify(queryEmbedding), userId, limit]);

    if (!result.rows.length) return allMemories;

    const topKeys = new Set(result.rows.map(r => r.memory_key));
    const alwaysOn = allMemories.filter(m =>
      m.type === 'identity' || m.type === 'routine'
    ).slice(0, 4);
    const semantic = allMemories.filter(m => topKeys.has(m.key)).slice(0, 7);

    const seen = new Set();
    const combined = [...alwaysOn, ...semantic].filter(m => {
      if (seen.has(m.key)) return false;
      seen.add(m.key);
      return true;
    });
    return combined.slice(0, 10);
  } catch (err) {
    console.error('Semantic memory error, falling back to standard:', err);
    return allMemories;
  }
}

// Relevance decay penalty based on last_referenced_at / updated_at age
function decayPenalty(memory) {
  const ref = memory.last_referenced_at || memory.updated_at || memory.created_at;
  if (!ref) return 0;
  const ageDays = (Date.now() - new Date(ref).getTime()) / 86400000;
  if (ageDays > 60) return -2;
  if (ageDays > 30) return -1;
  return 0;
}

// Emotional keywords used to detect emotional conversation tone
const EMOTIONAL_TONE_KEYWORDS = [
  "feel", "feeling", "felt", "struggling", "hurt", "scared", "lonely",
  "grateful", "happy", "depressed", "anxious", "stressed", "overwhelmed",
  "proud", "ashamed", "heartbroken", "grief", "loss", "hopeless", "hopeful",
];

// Selective memory recall: strict mode scoping, relevance scoring, decay, 3-5 max
function buildMemoryContext(allMemories, mode, messages = []) {
  if (!allMemories || allMemories.length === 0) return [];

  // Strict mode scoping: only matching mode or 'all'
  const filtered = allMemories.filter((m) => !m.mode || m.mode === mode || m.mode === "all");

  // Extract keywords from last 3 user messages for broader context
  const recentUserTexts = (Array.isArray(messages) ? messages : [])
    .filter((m) => m?.role === "user" && typeof m.content === "string")
    .slice(-3)
    .map((m) => m.content);
  const combinedText = recentUserTexts.join(" ");

  const userTerms = new Set(
    combinedText.toLowerCase().match(/\b[a-z]{4,}\b/g) || []
  );

  // Detect emotional conversation tone
  const lowerCombined = combinedText.toLowerCase();
  const isEmotional = EMOTIONAL_TONE_KEYWORDS.some((kw) => lowerCombined.includes(kw));

  function relevance(memory) {
    const text = String(memory?.value || "").toLowerCase();
    let score = 0;

    // Keyword overlap
    for (const term of userTerms) {
      if (text.includes(term)) score += 1;
    }

    // Emotional tone boost
    if (isEmotional && memory.type === "emotional_moment") score += 2;

    // Recency bonus (last 30 days)
    const ref = memory.last_referenced_at || memory.updated_at || memory.created_at;
    if (ref) {
      const ageDays = (Date.now() - new Date(ref).getTime()) / 86400000;
      if (ageDays < 30) score += 1;
    }

    // Decay penalty (>30d: -1, >60d: -2)
    score += decayPenalty(memory);

    return score;
  }

  const sorted = filtered.sort((a, b) => {
    const relA = relevance(a);
    const relB = relevance(b);

    if (relA !== relB) return relB - relA;

    // Prefer high confidence
    if (a.confidence === "high" && b.confidence !== "high") return -1;
    if (b.confidence === "high" && a.confidence !== "high") return 1;

    // Recency tiebreaker
    return new Date(b.updated_at) - new Date(a.updated_at);
  });

  // Selective recall: 20 memories max (4 routine + 4 world_detail + 12 flex)
  const TOTAL_SLOTS = 20;
  const ROUTINE_SLOTS = 4;
  const WORLD_DETAIL_SLOTS = 4;
  const FLEX_SLOTS = TOTAL_SLOTS - ROUTINE_SLOTS - WORLD_DETAIL_SLOTS; // 12

  const routinePool     = sorted.filter(m => m.type === "routine");
  const worldDetailPool = sorted.filter(m => m.type === "world_detail");

  const routinePick     = routinePool.slice(0, ROUTINE_SLOTS);
  const worldDetailPick = worldDetailPool.slice(0, WORLD_DETAIL_SLOTS);

  // Overflow: unfilled reserved slots go back into flex pool
  const unusedRoutineSlots     = ROUTINE_SLOTS - routinePick.length;
  const unusedWorldDetailSlots = WORLD_DETAIL_SLOTS - worldDetailPick.length;
  const extraFlexSlots         = unusedRoutineSlots + unusedWorldDetailSlots;

  // Build flex candidates from overflow of reserved pools + everything else, re-sorted by score
  const overflowCandidates = [
    ...routinePool.slice(ROUTINE_SLOTS),
    ...worldDetailPool.slice(WORLD_DETAIL_SLOTS),
    ...sorted.filter(m => m.type !== "routine" && m.type !== "world_detail"),
  ].sort((a, b) => {
    // Priority (highest first); missing/null/undefined treated as 0
    const prioA = Number(a.priority) || 0;
    const prioB = Number(b.priority) || 0;
    if (prioA !== prioB) return prioB - prioA;
    const relA = relevance(a);
    const relB = relevance(b);
    if (relA !== relB) return relB - relA;
    if (a.confidence === "high" && b.confidence !== "high") return -1;
    if (b.confidence === "high" && a.confidence !== "high") return 1;
    return new Date(b.updated_at) - new Date(a.updated_at);
  });

  const flexPick = overflowCandidates.slice(0, FLEX_SLOTS + extraFlexSlots);

  const selected = [...routinePick, ...worldDetailPick, ...flexPick];

  // Diagnostic logging — remove after investigation
  console.log(`[MEMORY COUNT] ${selected.length} memories injected`);
  for (const m of selected) {
    console.log(`[MEMORY INJECT] [p${m.priority ?? 0}] ${m.key}: ${m.value}`);
  }

  return selected;
}

function extractLastUserText(messages) {
  const lastUser = Array.isArray(messages)
    ? [...messages].reverse().find((m) => m && m.role === "user" && typeof m.content === "string")
    : null;
  return String(lastUser?.content ?? "");
}


// Minimal post-gen guard to prevent curt default opener on early turns
// Post-generation safety net for a known bad opener on the very first turn.
// NOTE: This is a fallback only. Persona-level behavior should be defined in prompts.js,
// not here. If Cal's opener problem is resolved in the prompt, this can be removed.
function softenEarlySnap(reply, messages) {
  if (!Array.isArray(messages) || messages.length <= 1) {
    const r = String(reply || "").trim().toLowerCase();
    if (r === "what do you want?" || r === "focus. what do you want?") {
      return "Yeah. I'm here.";
    }
  }
  return reply;
}

// Split a plain-text reply into segments ≤350 chars at sentence boundaries.
// Returns a single-element array if markdown indicators are detected or the
// text is already short enough.
function splitIntoMessages(text) {
  // If any markdown indicators are present, send as a single message
  if (/[#`]|\*\*|^[-*] |\d+\. /m.test(text)) {
    return [text];
  }

  // Short enough — no split needed
  if (text.length <= 350) {
    return [text];
  }

  // Split on sentence-ending punctuation followed by whitespace.
  // Lookbehind keeps the punctuation with the preceding sentence.
  const parts = text.split(/(?<=[.!?])\s+/);

  const segments = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? current + " " + part : part;
    if (candidate.length <= 350) {
      current = candidate;
    } else {
      if (current) segments.push(current);
      current = part;
    }
  }
  if (current) segments.push(current);

  return segments.length > 0 ? segments : [text];
}

function violatesHardTaboo(userTextRaw) {
  const t = String(userTextRaw || "").toLowerCase();

  const incestPatterns = [
    /\bstep[-\s]?(brother|sister|dad|mom|father|mother|son|daughter)\b/i,
    /\b(stepbro|stepsis)\b/i,
    /\bincest\b/i,
  ];

  const minorPatterns = [
    /\bminor\b/i,
    /\bunder ?age\b/i,
    // "teen" and "kid" scoped to sexual context to avoid false positives
    // ("my teen years", "I'm a kid at heart", etc.)
    /\bteen\s+(boy|girl|guy|bro|sis|male|female)\b/i,
    /\b(teen|child|kid)\s+(sex|porn|nude|naked|touching|fondl)\b/i,
    /\b(sex|fuck|touch|naked|nude)\s+(a\s+)?(teen|child|kid|minor)\b/i,
    /\blittle (girl|boy)\b/i,
    /\bschoolgirl\b/i,
    /\bschoolboy\b/i,
  ];

  const nonConPatterns = [
    /\bno means yes\b/i,
    /\bignore (my|the) no\b/i,
    // "force/forced" scoped to remove false positives ("forced perspective", "forced to watch")
    /\bforce\s+(me|him|her|them|you|us|sex|it)\b/i,
    /\bforced\s+(sex|intercourse|himself|herself|themselves|me|him|her|them)\b/i,
  ];

  if (incestPatterns.some((r) => r.test(t))) return "incest_stepfamily";
  if (minorPatterns.some((r) => r.test(t))) return "minors";
  if (nonConPatterns.some((r) => r.test(t))) return "nonconsent";
  return null;
}

// -----------------------------------
// Auth (Tester Codes - Phase 9)
// -----------------------------------
//
// Supports BOTH:
// 1) legacy username/password (for your own admin/dev usage)
// 2) testerCode login (recommended for Phase 9)
//
// ENV:
// - TESTER_CODES: comma-separated allowlist
// - TESTER_ADULT_CODES: optional comma-separated subset allowed NSFW/adultVerified=true
// - DEV_AUTH_USER / DEV_AUTH_PASS: optional legacy fallback (or keep existing AUTH_USER/AUTH_PASS)

function csvEnv(name) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TESTER_CODES = new Set(csvEnv("TESTER_CODES").map((c) => c.toUpperCase()));
const TESTER_ADULT_CODES = new Set(csvEnv("TESTER_ADULT_CODES").map((c) => c.toUpperCase()));

function makeSessionToken(prefix) {
  return `${prefix}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}`;
}

function signJwt(userId, adultVerified, founder = false) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET not configured");
  return jwt.sign(
    { sub: userId, capability: adultVerified ? "after_dark" : "sfw", adult: adultVerified, founder: Boolean(founder) },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function verifyJwt(token) {
  if (!JWT_SECRET) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// -----------------------------------
// Admin Auth Middleware
// -----------------------------------
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, error: "Admin not configured." });
  }
  const authHeader = String(req.headers?.authorization || "").trim();
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }
  const token = authHeader.slice(7).trim();
  if (token !== secret) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }
  next();
}

// -----------------------------------
// Token Verification Helpers
// -----------------------------------

/**
 * Extracts the tester code from a Bearer token.
 * Token format: "tester:CODE.timestamp.random" or "dev.timestamp.random"
 * Returns the code in uppercase, or null if not a tester token.
 */
function extractTokenCode(req) {
  const authHeader = String(req.headers?.authorization || "").trim();
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;

  const token = authHeader.slice(7).trim();
  // tester tokens are prefixed "tester:CODE."
  const match = token.match(/^tester:([A-Z0-9_-]+)\./i);
  if (!match) return null;

  return match[1].toUpperCase();
}

/**
 * Returns true if the request carries a token belonging to TESTER_ADULT_CODES.
 * Falls back to false for dev tokens or missing/malformed tokens.
 */
function isAdultVerifiedToken(req) {
  const code = extractTokenCode(req);
  if (code) return TESTER_ADULT_CODES.has(code);
  // For JWT-authenticated users, req.adultVerified is set by requireAuth
  if (req.adultVerified) return true;
  return false;
}

// -----------------------------------
// Auth Middleware
// -----------------------------------

/**
 * requireAuth — verifies a Bearer token on protected endpoints.
 *
 * Valid tokens:
 *   1) tester:CODE.* where CODE is in TESTER_CODES
 *   2) dev.* where DEV_AUTH_USER / DEV_AUTH_PASS are configured in env
 *      (allows local development without tester codes)
 *
 * /auth, /health, and / are intentionally excluded.
 */
function requireAuth(req, res, next) {
  const authHeader = String(req.headers?.authorization || "").trim();

  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    if (DEBUG_CHAT) console.log("[AUTH] Rejected: missing Bearer token", req.path);
    return res.status(401).json({ ok: false, error: "Authentication required." });
  }

  const token = authHeader.slice(7).trim();

  // --- Tester code path ---
  const testerMatch = token.match(/^tester:([A-Z0-9_-]+)\./i);
  if (testerMatch) {
    const code = testerMatch[1].toUpperCase();
    if (!TESTER_CODES.size) {
      // Server misconfiguration — TESTER_CODES env not set
      if (DEBUG_CHAT) console.log("[AUTH] Rejected: TESTER_CODES not configured");
      return res.status(500).json({ ok: false, error: "Server auth not configured." });
    }
    if (!TESTER_CODES.has(code)) {
      if (DEBUG_CHAT) console.log("[AUTH] Rejected: unknown tester code", code);
      return res.status(401).json({ ok: false, error: "Invalid or expired token." });
    }
    return next();
  }

  // --- JWT path ---
  const jwtPayload = verifyJwt(token);
  if (jwtPayload && jwtPayload.sub) {
    req.userId = parseInt(jwtPayload.sub, 10);
    req.adultVerified = Boolean(jwtPayload.adult);
    req.founder = Boolean(jwtPayload.founder);
    req.userCapability = jwtPayload.capability || "just_right";
    return next();
  }

  // --- Dev token path ---
  const devMatch = token.match(/^dev\./i);
  if (devMatch) {
    const devUser = process.env.DEV_AUTH_USER || process.env.AUTH_USER || "";
    const devPass = process.env.DEV_AUTH_PASS || process.env.AUTH_PASS || "";
    if (devUser && devPass) {
      // Dev creds configured — dev tokens are valid
      return next();
    }
    // No dev creds configured — reject dev tokens in production
    if (DEBUG_CHAT) console.log("[AUTH] Rejected: dev token but no DEV_AUTH_USER/PASS set");
    return res.status(401).json({ ok: false, error: "Invalid or expired token." });
  }

  // --- Unrecognized token format ---
  if (DEBUG_CHAT) console.log("[AUTH] Rejected: unrecognized token format", req.path);
  return res.status(401).json({ ok: false, error: "Invalid or expired token." });
}

app.post("/auth", authLimiter, async (req, res) => {
  const body = req.body || {};

  // New path: tester code
  const codeRaw = body.code || (body.username && !body.password ? body.username : null);
  const code = String(codeRaw || "").trim().toUpperCase();

  if (code) {
    if (!TESTER_CODES.size) {
      return res.status(500).json({ ok: false, error: "TESTER_CODES not configured on server." });
    }

    if (!TESTER_CODES.has(code)) {
      return res.status(401).json({ ok: false, error: "Invalid tester code." });
    }

    const adultVerified = TESTER_ADULT_CODES.size ? TESTER_ADULT_CODES.has(code) : false;

    return res.json({
      ok: true,
      token: makeSessionToken(`tester:${code}`),
      testerCode: code,
      adultVerified,
    });
  }

  // Username/password path: check database
  const { username, password, device_id } = body;

  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      error: "Missing credentials (provide tester code or username/password).",
    });
  }

  if (!db) {
    return res.status(503).json({ ok: false, error: "Database not available." });
  }

  try {
    const loginId = String(username).toLowerCase();
    const result = await db.query(
      "SELECT id, username, email, password_hash, adult_verified, founder FROM users WHERE username = $1 OR email = $1",
      [loginId]
    );

    if (result.rows.length === 0) {
      console.log("AUTH: no user found for username/email:", loginId);
      return res.status(401).json({ ok: false, error: "Invalid username or password." });
    }

    const user = result.rows[0];
    console.log("AUTH: lookup result", {
      user_id: user.id,
      username: user.username,
      email: user.email,
      has_password_hash: !!user.password_hash,
      hash_prefix: user.password_hash?.substring(0, 7),
    });

    const valid = await bcrypt.compare(password, user.password_hash);
    console.log("AUTH: bcrypt.compare result", { user_id: user.id, valid });

    if (!valid) {
      return res.status(401).json({ ok: false, error: "Invalid username or password." });
    }

    // Lazy founder application: check if device redeemed an after_dark code with founder=true
    if (device_id && !user.founder) {
      try {
        const founderCheck = await db.query(
          "SELECT id FROM invite_codes WHERE used_by_device_id = $1 AND founder = true LIMIT 1",
          [device_id]
        );
        if (founderCheck.rows.length > 0) {
          await db.query("UPDATE users SET founder = true WHERE id = $1", [user.id]);
          user.founder = true;
        }
      } catch (e) {
        console.warn("[AUTH] Founder check failed:", e?.message);
      }
    }

    if (device_id) {
      try {
        await db.query("UPDATE users SET device_id = $1 WHERE id = $2", [device_id, user.id]);
      } catch (e) {
        console.warn("[AUTH] device_id update failed:", e?.message);
      }
    }

    let hasOrphanedMemories = false;
    let hasOtherDeviceMemories = false;
    let otherDeviceIds = [];
    if (device_id) {
      const orphanCheck = await db.query(
        "SELECT 1 FROM memories WHERE device_id = $1 AND user_id IS NULL LIMIT 1",
        [device_id]
      );
      hasOrphanedMemories = orphanCheck.rows.length > 0;

      const otherDeviceCheck = await db.query(
        "SELECT DISTINCT device_id FROM memories WHERE user_id = $1 AND device_id != $2",
        [user.id, device_id]
      );
      hasOtherDeviceMemories = otherDeviceCheck.rows.length > 0;
      otherDeviceIds = otherDeviceCheck.rows.map(r => r.device_id);
    }

    const token = signJwt(user.id, user.adult_verified, user.founder);
    console.log('[AUTH] signJwt founder value:', user.founder);

    return res.json({
      ok: true,
      token,
      user: { id: user.id, username: user.username, email: user.email, adultVerified: user.adult_verified, founder: user.founder || false },
      hasOrphanedMemories,
      hasOtherDeviceMemories,
      otherDeviceIds,
    });
  } catch (err) {
    console.error("AUTH LOGIN ERROR:", err);
    return res.status(500).json({ ok: false, error: "Login failed." });
  }
});

// -----------------------------------
// User Auth Endpoints
// -----------------------------------

app.post("/signup", authLimiter, async (req, res) => {
  try {
    const { username, email, password, device_id } = req.body || {};

    if (!username || !email || !password) {
      return res.status(400).json({ ok: false, error: "username, email, and password required." });
    }
    if (typeof username !== "string" || username.length < 3 || username.length > 50) {
      return res.status(400).json({ ok: false, error: "Username must be 3-50 characters." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "Invalid email format." });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: "Password must be at least 8 characters." });
    }
    if (!db) {
      return res.status(503).json({ ok: false, error: "Database not available." });
    }
    if (!JWT_SECRET) {
      return res.status(500).json({ ok: false, error: "Auth not configured on server." });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = await db.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, adult_verified, founder, created_at`,
      [username.toLowerCase(), email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];

    // Lazy founder application: check if device redeemed an after_dark code with founder=true
    if (device_id && !user.founder) {
      try {
        const founderCheck = await db.query(
          "SELECT id FROM invite_codes WHERE used_by_device_id = $1 AND founder = true LIMIT 1",
          [device_id]
        );
        if (founderCheck.rows.length > 0) {
          await db.query("UPDATE users SET founder = true WHERE id = $1", [user.id]);
          user.founder = true;
        }
      } catch (e) {
        console.warn("[SIGNUP] Founder check failed:", e?.message);
      }
    }

    if (device_id) {
      try {
        await db.query("UPDATE users SET device_id = $1 WHERE id = $2", [device_id, user.id]);
      } catch (e) {
        console.warn("[SIGNUP] device_id update failed:", e?.message);
      }
    }

    const token = signJwt(user.id, user.adult_verified, user.founder);

    return res.json({
      ok: true,
      token,
      user: { id: user.id, username: user.username, email: user.email, adultVerified: user.adult_verified, founder: user.founder || false },
    });
  } catch (err) {
    if (err.code === "23505") {
      const detail = String(err.detail || "");
      if (detail.includes("username")) {
        return res.status(409).json({ ok: false, error: "Username already taken." });
      }
      if (detail.includes("email")) {
        return res.status(409).json({ ok: false, error: "Email already registered." });
      }
      return res.status(409).json({ ok: false, error: "Username or email already taken." });
    }
    console.error("SIGNUP ERROR:", err);
    return res.status(500).json({ ok: false, error: "Signup failed." });
  }
});

app.post("/login", authLimiter, async (req, res) => {
  try {
    const { username, password, device_id } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "username and password required." });
    }
    if (!db || !JWT_SECRET) {
      return res.status(503).json({ ok: false, error: "Auth not available." });
    }

    const loginId = String(username).toLowerCase();
    const result = await db.query(
      "SELECT id, username, email, password_hash, adult_verified, founder FROM users WHERE username = $1 OR email = $1",
      [loginId]
    );

    if (result.rows.length === 0) {
      console.log("AUTH: no user found for username/email:", loginId);
      return res.status(401).json({ ok: false, error: "Invalid username or password." });
    }

    const user = result.rows[0];
    console.log("AUTH: lookup result", {
      user_id: user.id,
      username: user.username,
      email: user.email,
      has_password_hash: !!user.password_hash,
      hash_prefix: user.password_hash?.substring(0, 7),
    });
    const valid = await bcrypt.compare(password, user.password_hash);
    console.log("AUTH: bcrypt.compare result", { user_id: user.id, valid });
    if (!valid) {
      return res.status(401).json({ ok: false, error: "Invalid username or password." });
    }

    // Lazy founder application: check if device redeemed an after_dark code with founder=true
    if (device_id && !user.founder) {
      try {
        const founderCheck = await db.query(
          "SELECT id FROM invite_codes WHERE used_by_device_id = $1 AND founder = true LIMIT 1",
          [device_id]
        );
        if (founderCheck.rows.length > 0) {
          await db.query("UPDATE users SET founder = true WHERE id = $1", [user.id]);
          user.founder = true;
        }
      } catch (e) {
        console.warn("[LOGIN] Founder check failed:", e?.message);
      }
    }

    if (device_id) {
      try {
        await db.query("UPDATE users SET device_id = $1 WHERE id = $2", [device_id, user.id]);
      } catch (e) {
        console.warn("[LOGIN] device_id update failed:", e?.message);
      }
    }

    let hasOrphanedMemories = false;
    let hasOtherDeviceMemories = false;
    let otherDeviceIds = [];
    if (device_id) {
      const orphanCheck = await db.query(
        "SELECT 1 FROM memories WHERE device_id = $1 AND user_id IS NULL LIMIT 1",
        [device_id]
      );
      hasOrphanedMemories = orphanCheck.rows.length > 0;

      const otherDeviceCheck = await db.query(
        "SELECT DISTINCT device_id FROM memories WHERE user_id = $1 AND device_id != $2",
        [user.id, device_id]
      );
      hasOtherDeviceMemories = otherDeviceCheck.rows.length > 0;
      otherDeviceIds = otherDeviceCheck.rows.map(r => r.device_id);
    }

    const token = signJwt(user.id, user.adult_verified, user.founder);
    console.log('[AUTH] signJwt founder value:', user.founder);

    return res.json({
      ok: true,
      token,
      user: { id: user.id, username: user.username, email: user.email, adultVerified: user.adult_verified, founder: user.founder || false },
      hasOrphanedMemories,
      hasOtherDeviceMemories,
      otherDeviceIds,
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({ ok: false, error: "Login failed." });
  }
});

// -----------------------------------
// Admin: Invite Code Generation
// -----------------------------------
app.post("/admin/generate-code", requireAdmin, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ ok: false, error: "Database not available." });
    }

    const { tier } = req.body || {};
    const validTiers = ["just_right", "turn_it_up", "after_dark"];
    if (!tier || !validTiers.includes(tier)) {
      return res.status(400).json({
        ok: false,
        error: `Invalid tier. Must be one of: ${validTiers.join(", ")}`,
      });
    }

    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bytes = crypto.randomBytes(8);
    const code = Array.from(bytes).map((b) => chars[b % chars.length]).join("");

    await db.query(
      "INSERT INTO invite_codes (code, tier) VALUES ($1, $2)",
      [code, tier]
    );

    return res.json({ ok: true, code, tier });
  } catch (err) {
    if (err.code === "23505") {
      // Unique constraint collision — retry once
      try {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        const bytes = crypto.randomBytes(8);
        const code = Array.from(bytes).map((b) => chars[b % chars.length]).join("");
        const { tier } = req.body || {};
        await db.query("INSERT INTO invite_codes (code, tier) VALUES ($1, $2)", [code, tier]);
        return res.json({ ok: true, code, tier });
      } catch (retryErr) {
        console.error("GENERATE-CODE RETRY ERROR:", retryErr);
        return res.status(500).json({ ok: false, error: "Code generation failed." });
      }
    }
    console.error("GENERATE-CODE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Code generation failed." });
  }
});

// -----------------------------------
// Redeem Invite Code (no auth required)
// -----------------------------------
app.post("/redeem-code", authLimiter, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ ok: false, error: "Database not available." });
    }

    const { code, device_id } = req.body || {};
    if (!code || !device_id) {
      return res.status(400).json({ ok: false, error: "code and device_id required." });
    }

    const normalized = String(code).trim().toUpperCase();

    // Look up the code
    const result = await db.query(
      "SELECT id, tier, used FROM invite_codes WHERE code = $1",
      [normalized]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Invalid invite code." });
    }

    const invite = result.rows[0];
    if (invite.used) {
      return res.status(409).json({ ok: false, error: "This code has already been used." });
    }

    // Determine founder eligibility and mark code as used inside a serializable
    // transaction to prevent two simultaneous redemptions both reading count < 20.
    let founder = false;
    const client = await db.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");

      if (invite.tier === "after_dark") {
        const countResult = await client.query(
          "SELECT COUNT(*) AS cnt FROM users WHERE founder = true"
        );
        const founderCount = parseInt(countResult.rows[0].cnt, 10);
        founder = founderCount < 20;
      }

      // Mark code as used
      await client.query(
        `UPDATE invite_codes
         SET used = true, used_by_device_id = $1, redeemed_at = NOW(), founder = $2
         WHERE id = $3`,
        [device_id, founder, invite.id]
      );

      // Best-effort: try to find a user associated with this device_id and set founder
      if (founder) {
        const userLookup = await client.query(
          "SELECT DISTINCT user_id FROM user_activity WHERE device_id = $1 AND user_id IS NOT NULL LIMIT 1",
          [device_id]
        );
        if (userLookup.rows.length > 0) {
          await client.query(
            "UPDATE users SET founder = true WHERE id = $1",
            [userLookup.rows[0].user_id]
          );
        }
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    return res.json({ ok: true, tier: invite.tier, founder });
  } catch (err) {
    console.error("REDEEM-CODE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Redemption failed." });
  }
});

app.post("/forgot-password", authLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !db) return res.json({ ok: true });

    const result = await db.query("SELECT id FROM users WHERE email = $1", [String(email).toLowerCase()]);
    if (result.rows.length === 0) return res.json({ ok: true });

    const userId = result.rows[0].id;
    const resetToken = crypto.randomBytes(32).toString("hex");

    await db.query(
      "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
      [userId, resetToken]
    );

    const resetUrl = `https://app.calafterdark.com/reset?token=${resetToken}`;

    if (resend) {
      try {
        await resend.emails.send({
          from: EMAIL_FROM,
          to: email,
          subject: "Cal — Password Reset",
          text: `Reset your password: ${resetUrl}\n\nThis link expires in 1 hour.`,
          html: `<p>Reset your password:</p><p><a href="${resetUrl}">Click here</a></p><p>This link expires in 1 hour.</p>`,
        });
      } catch (emailErr) {
        console.warn("Failed to send reset email:", emailErr?.message || emailErr);
      }
    } else {
      console.warn("[FORGOT-PASSWORD] No RESEND_API_KEY configured. Reset token:", resetToken);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("FORGOT-PASSWORD ERROR:", err);
    return res.json({ ok: true });
  }
});

// GET /reset-password — redirect from email link to app deep link
app.get("/reset-password", (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send("Missing reset token.");
  }
  const deepLink = `cal://reset-password?token=${encodeURIComponent(token)}`;
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cal — Password Reset</title>
</head><body style="font-family:system-ui;text-align:center;padding:60px 20px">
<h2>Opening Cal...</h2>
<p><a href="${deepLink}" id="open-btn"
      style="display:inline-block;padding:14px 28px;background:#111;color:#fff;
             border-radius:8px;text-decoration:none;font-size:16px">
  Open in Cal
</a></p>
<p id="fallback" style="display:none;margin-top:24px;color:#666">
  App didn't open? Make sure Cal is installed, then tap the button above.
</p>
<script>
  window.location.href = "${deepLink}";
  setTimeout(function() {
    document.getElementById('fallback').style.display = 'block';
  }, 2000);
</script>
</body></html>`);
});

app.post("/reset-password", authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};

    if (!token || !password) {
      return res.status(400).json({ ok: false, error: "token and password required." });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: "Password must be at least 8 characters." });
    }
    if (!db) {
      return res.status(503).json({ ok: false, error: "Database not available." });
    }

    const result = await db.query(
      "SELECT id, user_id FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()",
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ ok: false, error: "Invalid or expired reset link." });
    }

    const { id: tokenId, user_id: userId } = result.rows[0];
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    console.log("RESET-PASSWORD: updating", { userId, hash_prefix: passwordHash.substring(0, 7) });

    const updateResult = await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
    if (updateResult.rowCount === 0) {
      console.error("RESET-PASSWORD: UPDATE matched 0 rows for user_id:", userId);
      return res.status(500).json({ ok: false, error: "Password reset failed — user not found." });
    }

    await db.query("UPDATE password_reset_tokens SET used = TRUE WHERE id = $1", [tokenId]);
    console.log("RESET-PASSWORD: password updated for user_id:", userId, "hash_prefix:", passwordHash.substring(0, 7));

    return res.json({ ok: true });
  } catch (err) {
    console.error("RESET-PASSWORD ERROR:", err);
    return res.status(500).json({ ok: false, error: "Password reset failed." });
  }
});

// -----------------------------------
// Memory Detection (Phase 3 + Phase 4 Refinements)
// -----------------------------------

/**
 * PHASE 4: Emotional state stop-words (DO NOT capture as identity)
 */
const IDENTITY_STOPWORDS = [
  "tired",
  "exhausted",
  "sleepy",
  "awake",
  "alert",
  "horny",
  "turned on",
  "aroused",
  "hard",
  "wet",
  "bored",
  "excited",
  "nervous",
  "anxious",
  "stressed",
  "happy",
  "sad",
  "angry",
  "mad",
  "upset",
  "frustrated",
  "hungry",
  "thirsty",
  "full",
  "stuffed",
  "drunk",
  "tipsy",
  "high",
  "sober",
  "hot",
  "cold",
  "warm",
  "cool",
  "gay",
  "straight",
  "bi",
  "queer",
  "trans",
  "single",
  "taken",
  "married",
  "divorced",
  "ready",
  "done",
  "finished",
  "busy",
  "free",
  "sure",
  "certain",
  "unsure",
  "confused",
  "interested",
  "curious",
  "skeptical",
];

/**
 * Emotional stopwords — transient states that shouldn't become emotional_moment memories
 */
const EMOTIONAL_STOPWORDS = [
  "tired", "exhausted", "sleepy", "bored", "hungry", "thirsty",
  "full", "stuffed", "fine", "okay", "ok", "good", "bad", "meh",
  "weird", "off", "sick", "ill", "better", "worse",
];

/**
 * Map detection category → memory type
 */
function typeFromCategory(category) {
  if (category === "emotional_moment") return "emotional_moment";
  if (category === "recurring_theme") return "routine";
  if (category === "identity") return "identity";
  if (category === "boundaries") return "identity";
  if (category === "activities") return "routine";
  return "preference"; // preferences, dislikes
}

/**
 * PHASE 4: Hardened patterns with better identity detection
 */
const MEMORY_PATTERNS = {
  preferences: [
    /\b(?:i|i'm|im)\s+(?:really\s+)?(?:into|love|like|enjoy|prefer)\s+(.+?)(?:\.|,|!|$)/i,
    /\b(?:i|i'm|im)\s+(?:a\s+)?(?:big\s+)?fan\s+of\s+(.+?)(?:\.|,|!|$)/i,
  ],
  dislikes: [
    /\b(?:i|i'm|im)\s+not\s+(?:into|a fan of|interested in)\s+(.+?)(?:\.|,|!|$)/i,
    /\b(?:i|i'm|im)\s+(?:really\s+)?(?:hate|dislike|can't stand)\s+(.+?)(?:\.|,|!|$)/i,
    /\bdon't\s+(?:call me|use)\s+(.+?)(?:\.|,|!|$)/i,
  ],
  identity: [
    // PHASE 4: Strict name patterns only
    /\bmy\s+name\s+is\s+([A-Z][a-z]+)(?:\.|,|!|$)/i,
    /\bcall\s+me\s+([A-Z][a-z]+)(?:\.|,|!|$)/i,
    // PHASE 4: Profession patterns (explicit list, not emotional states)
    /\b(?:i|i'm|im)\s+a\s+(developer|engineer|designer|teacher|student|doctor|nurse|artist|writer|musician|chef|bartender|manager|consultant|analyst|architect|accountant|lawyer|therapist|coach|trainer|mechanic|electrician|plumber|carpenter|contractor|realtor|salesperson|marketer|photographer|videographer|editor|producer|director|actor|model|athlete|veteran|military|pilot|driver|paramedic|firefighter|officer|detective|scientist|researcher|professor|instructor|tutor)(?:\s|\.|\,|!|$)/i,
  ],
  activities: [
    /\b(?:i|i'm|im)\s+(?:currently\s+)?(?:working on|building|creating|studying|learning|practicing)\s+(.+?)(?:\.|,|!|$)/i,
    /\b(?:i|i'm|im)\s+(?:trying to|planning to|hoping to)\s+(.+?)(?:\.|,|!|$)/i,
  ],
  boundaries: [
    /\bnever\s+(?:call me|say|use|mention|bring up)\s+(.+?)(?:\.|,|!|$)/i,
    /\bdon't\s+(?:ever\s+)?(?:mention|bring up|talk about|ask about)\s+(.+?)(?:\.|,|!|$)/i,
  ],
  emotional_moment: [
    /\b(?:i feel|i'm feeling|i felt)\s+(?:really\s+)?(.+?)(?:\.|,|!|$)/i,
    /\b(?:i've been|i was)\s+(?:struggling|dealing|coping)\s+(?:with\s+)?(.+?)(?:\.|,|!|$)/i,
    /\b(?:it really)\s+(?:hurt|helped|meant a lot|affected me)(.*)(?:\.|,|!|$)/i,
  ],
};

/**
 * PHASE 4: Enhanced detection with stopword filtering
 */
function detectMemoriesHeuristic(userText) {
  const detected = [];

  // Check each pattern category
  for (const [category, patterns] of Object.entries(MEMORY_PATTERNS)) {
    for (const pattern of patterns) {
      const match = userText.match(pattern);
      if (match && match[1]) {
        const value = match[1].trim();

        // Skip very short matches (likely false positives)
        if (value.length < 3) continue;

        // Phase 11.7: Skip overly long captures (usually vague / messy / low quality)
        if (value.length > 80) continue;

        // Phase 11.7: Reject obvious roleplay / hypothetical / joke-ish fragments
const lowerValue = value.toLowerCase();

// Reject vulgar fragments
const blockedFragments = [
  "fucking",
  "fuck",
  "messing with",
  "trolling",
  "playing with",
  "screwing with"
];

if (blockedFragments.some(word => lowerValue.includes(word))) {
  continue;
}

// Reject behavior phrases involving people
if (/\b(fuck|mess|play|screw|troll)\b.*\b(people|someone|others)\b/i.test(lowerValue)) {
  continue;
}

// Reject roleplay / joking phrases
if (
  lowerValue.includes("pretend") ||
  lowerValue.includes("roleplay") ||
  lowerValue.includes("what if") ||
  lowerValue.includes("maybe") ||
  lowerValue.includes("kidding") ||
  lowerValue.includes("joking")
) {
  continue;
}

        // PHASE 4: For identity category, check stopwords
        if (category === "identity") {
          if (IDENTITY_STOPWORDS.some((word) => lowerValue === word || lowerValue.includes(word))) {
            continue;
          }
        }

        // Filter transient emotional states from emotional_moment captures
        if (category === "emotional_moment") {
          if (EMOTIONAL_STOPWORDS.some((word) => lowerValue === word || lowerValue.includes(word))) {
            continue;
          }
        }

        // Generate a key based on category and content
        const key = `${category}_${value.toLowerCase().replace(/\s+/g, "_").substring(0, 30)}`;
        const formattedValue = formatMemoryValue(category, value);

        // Quality gate: skip entries that don't carry enough real information
        if (formattedValue.trim().split(/\s+/).length < 15) continue;

        detected.push({
          category,
          key,
          value: formattedValue,
          type: typeFromCategory(category),
          confidence: "low", // User-confirmed memories upgrade to 'high'
          matchedPattern: pattern.source,
        });
      }
    }
  }

  // Phase 11.7: Remove duplicate / near-identical suggestions
  return dedupeDetectedMemories(detected);
}
/**
 * PHASE 4: Format detected value into natural, relational statement
 */
function formatMemoryValue(category, rawValue) {
  switch (category) {
    case "preferences":
      return `Joey genuinely enjoys ${rawValue}.`;
    case "dislikes":
      return `Joey has expressed that he dislikes ${rawValue} and does not want it brought up.`;
    case "identity":
      return `Joey has identified himself as ${rawValue}.`;
    case "activities":
      return `Joey mentioned he is currently ${rawValue}.`;
    case "boundaries":
      return `Joey has set an explicit boundary: ${rawValue} should not be referenced or mentioned.`;
    case "emotional_moment":
      return `Joey shared that he has been ${rawValue}, which came up in their conversation.`;
    default:
      return rawValue;
  }
}

function containsCorrection(text) {
  const t = String(text || "").toLowerCase();

  return (
    t.includes("actually") ||
    t.includes("wait") ||
    t.includes("i meant") ||
    t.includes("that was wrong") ||
    t.includes("that's wrong") ||
    t.includes("correction") ||
    t.includes("to be clear") ||
    t.includes("let me correct that") ||
    t.includes("scratch that")
  );
}

function dedupeDetectedMemories(memories) {
  const seen = new Set();
  const unique = [];

  for (const memory of memories) {
    const normalized = String(memory?.value || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    unique.push(memory);
  }

  return unique;
}

// -----------------------------------
// Session Summary Helper
// -----------------------------------
async function generateSummaryText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const summaryMsgs = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
  if (summaryMsgs.length && summaryMsgs[summaryMsgs.length - 1].role === "assistant") {
    summaryMsgs.push({ role: "user", content: "Please summarize the above conversation." });
  }
  const completion = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    system: SESSION_SUMMARY_PROMPT,
    messages: summaryMsgs,
    temperature: 0.3,
    max_tokens: 200,
  });
  console.log('[TOKENS]', { input: completion.usage.input_tokens, output: completion.usage.output_tokens, total: completion.usage.input_tokens + completion.usage.output_tokens });
  return completion?.content?.[0]?.text?.trim() || "";
}

async function generateThreadTitle(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const titleMsgs = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
  if (titleMsgs.length && titleMsgs[titleMsgs.length - 1].role === "assistant") {
    titleMsgs.push({ role: "user", content: "Please generate a title for the above conversation." });
  }
  const completion = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    system: THREAD_TITLE_PROMPT,
    messages: titleMsgs,
    temperature: 0.3,
    max_tokens: 20,
  });
  console.log('[TOKENS]', { input: completion.usage.input_tokens, output: completion.usage.output_tokens, total: completion.usage.input_tokens + completion.usage.output_tokens });
  return completion?.content?.[0]?.text?.trim() || "";
}

async function generateAndStoreSessionSummary({ messages, mode, deviceId, userId, threadId = null }) {
  const summary = await generateSummaryText(messages);
  if (!summary || !db) return;

  // Upsert: replace today's row for this user/device/mode
  await db.query(
    `DELETE FROM session_summaries
     WHERE (user_id = $1 OR (user_id IS NULL AND device_id = $2))
       AND mode = $3
       AND DATE(created_at) = CURRENT_DATE`,
    [userId, deviceId, mode]
  );
  await db.query(
    `INSERT INTO session_summaries (device_id, user_id, mode, summary)
     VALUES ($1, $2, $3, $4)`,
    [deviceId, userId, mode, summary]
  );

  if (threadId) {
    const title = await generateThreadTitle(messages);
    if (title) {
      await db.query(`UPDATE threads SET title = $1 WHERE id = $2`, [title, threadId]);
    }
  }
}

// -----------------------------------
// Chat Endpoint
// -----------------------------------
app.post("/chat", requireAuth, chatLimiter, async (req, res) => {
  try {
    const { messages = [], mode = "sfw", threadSummary = null, recentMessages = [], memories = [], threadId: threadIdCamel = null, thread_id: threadIdSnake = null, imageBase64 = null, imageMimeType = null, image_url = null } =
      req.body;
    const threadId = threadIdCamel ?? threadIdSnake;

    let effectiveThreadId = threadId;
    if (!effectiveThreadId && req.userId) {
      try {
        const threadResult = await db.query(
          'INSERT INTO threads (title, created_at) VALUES ($1, NOW()) RETURNING id',
          ['New Conversation']
        );
        effectiveThreadId = threadResult.rows[0].id;
      } catch (e) {
        // non-fatal — continue without a thread id
      }
    }

    if (imageBase64 || imageMimeType) {
      return res.status(400).json({ error: "imageBase64 is no longer supported. Upload via /upload-image and pass image_url." });
    }
    if (image_url && req.userId !== 3) {
      return res.status(403).json({ ok: false, error: 'Image upload not available on this account.' });
    }
    const pace = paceFromReq(req.body);

    // Start weather fetch early (runs concurrently with DB queries)
    const weatherPromise = fetchChicagoWeather();

    const userText = extractLastUserText(messages);

    const rawMessage = req.body?.messages?.[0]?.content || ''
    if (rawMessage.length > 4000) {
      return res.status(400).json({ ok: false, error: 'Message too long.' })
    }

    // Easter egg detection
    const easterEggTriggered = checkEasterEgg(userText);
    if (easterEggTriggered && db) {
      const eeDeviceId = req.body.device_id || null;
      const eeUserId = req.userId || null;
      const eeEffectiveDeviceId = eeDeviceId || `user_${eeUserId}`;

      const existing = await db.query(
        `SELECT id FROM memories WHERE device_id = $1 AND key = 'easter_egg_triggered'`,
        [eeEffectiveDeviceId]
      );

      if (existing.rows.length === 0) {
        await db.query(
          `INSERT INTO memories (device_id, key, value, mode, confidence, type, user_id)
           VALUES ($1, 'easter_egg_triggered', 'true', 'sfw', 'high', 'system', $2)
           ON CONFLICT (device_id, key) DO NOTHING`,
          [eeEffectiveDeviceId, eeUserId]
        );
        return res.json({
          ok: true,
          reply: "Sharp eyes.\nMost people never think to ask.",
          easterEgg: { triggered: true },
        });
      }
    }

    // Never call the API without a real user message.
    if (!userText.trim()) {
      return res.status(400).json({
        ok: false,
        error: "No user message provided (messages empty or missing role:'user').",
      });
    }

    const taboo = violatesHardTaboo(userText);
    if (taboo) {
      return res.json({
        ok: true,
        reply: "That's not something I do. Let's switch gears.",
        blocked: true,
        reason: taboo,
      });
    }

    // -----------------------------------
    // After Dark Adult Verification Gate
    // -----------------------------------
    if (mode === "after_dark") {
      if (req.userId && db) {
        const userRow = await db.query(
          'SELECT adult_verified FROM users WHERE id = $1',
          [req.userId]
        )
        if (!userRow.rows[0]?.adult_verified) {
          return res.status(403).json({ ok: false, error: 'Age verification required.' })
        }
      } else if (!isAdultVerifiedToken(req)) {
        return res.json({
          ok: true,
          reply: "After Dark mode isn't available on your account. You can switch to SFW in Settings.",
          blocked: true,
          reason: "adult_verification_required",
        });
      }
    }

    // -----------------------------------
    // Daily Message Limit Gate
    // -----------------------------------
    if (db && req.userId && req.userId !== 3) {
      try {
        const capability = req.userCapability || "just_right";
        const limit = MESSAGE_LIMITS[capability] ?? 20;
        if (limit !== Infinity) {
          const countResult = await db.query(
            `SELECT COUNT(*) FROM messages
             WHERE user_id = $1
             AND created_at >= NOW() AT TIME ZONE 'America/Chicago' - INTERVAL '1 day'
             AND role = 'assistant'`,
            [req.userId]
          );
          const used = parseInt(countResult.rows[0].count, 10);
          if (used >= limit) {
            const chicagoHour = parseInt(
              new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }),
              10
            );
            let softStop;
            if (chicagoHour >= 6 && chicagoHour <= 11) {
              softStop = "I'm gonna be in the workshop most of today. Come find me tomorrow.";
            } else if (chicagoHour >= 12 && chicagoHour <= 17) {
              softStop = "I've got some things to take care of this afternoon. Pick this up tomorrow?";
            } else if (chicagoHour >= 18 && chicagoHour <= 23) {
              softStop = "I'm heading out for a bit. Come find me tomorrow.";
            } else {
              softStop = "Go get some sleep. I'll be here tomorrow.";
            }
            return res.json({ ok: true, reply: softStop });
          }
        }
      } catch (e) {
        console.warn("[CHAT] Daily limit check failed:", e?.message);
      }
    }

    // Update last_active_at for push notification scheduling
    if (db && req.userId) {
      db.query("UPDATE users SET last_active_at = NOW() WHERE id = $1", [req.userId]).catch((e) =>
        console.warn("[CHAT] last_active_at update failed:", e.message)
      );
    }

    // Fetch founder, meta_aware, and cloud_messages status from users table
    let isFounder = false;
    let isMetaAware = false;
    let cloudMessages = false;
    if (db && req.userId) {
      try {
        const userResult = await db.query(
          "SELECT founder, meta_aware, cloud_messages FROM users WHERE id = $1",
          [req.userId]
        );
        if (userResult.rows.length > 0) {
          isFounder = Boolean(userResult.rows[0].founder);
          isMetaAware = Boolean(userResult.rows[0].meta_aware);
          cloudMessages = Boolean(userResult.rows[0].cloud_messages);
        }
      } catch (e) {
        console.warn("[CHAT] User lookup failed:", e?.message);
      }
    }

    // Fetch last session summary for continuity (best-effort)
    let lastSessionSummary = req.body.sessionSummary || null;
    if (!lastSessionSummary && db) {
      try {
        const deviceId = req.body.device_id || null;
        const userId = req.userId || null;
        if (deviceId || userId) {
          const ssResult = await db.query(
            `SELECT summary FROM session_summaries
             WHERE (user_id = $2 OR (user_id IS NULL AND device_id = $1)) AND mode = $3
             ORDER BY created_at DESC LIMIT 1`,
            [deviceId, userId, mode]
          );
          if (ssResult.rows.length > 0) {
            lastSessionSummary = ssResult.rows[0].summary;
          }
        }
      } catch (e) {
        console.warn("[SESSION] Summary fetch failed:", e?.message);
      }
    }

    const weather = await weatherPromise;
    const realtimeContext = buildRealtimeContext(weather);

    let filteredMemories = buildMemoryContext(memories, mode, messages);

    // Upgrade to semantic retrieval if we have a query to work with
    const lastUserMessage = messages.filter(m => m.role === 'user').slice(-1)[0];
    if (lastUserMessage && req.userId) {
      filteredMemories = await getSemanticMemories(
        req.userId,
        lastUserMessage.content,
        memories,
        10
      );
    }

    const systemPrompt = buildSystemPrompt({ mode, pace, memories: filteredMemories, lastSessionSummary, realtimeContext, founder: isFounder });


    // Update last_referenced_at for injected memories (fire-and-forget)
    if (db && filteredMemories.length > 0) {
      const ids = filteredMemories.map((m) => m.id).filter(Boolean);
      if (ids.length > 0) {
        db.query(
          `UPDATE memories SET last_referenced_at = NOW() WHERE id = ANY($1::int[])`,
          [ids]
        ).catch((e) => console.warn("[MEMORY] last_referenced_at update failed:", e?.message));
      }
    }

    const temperature =
      mode === "after_dark"
        ? pace === "AFTER_DARK"
          ? 0.95
          : pace === "TURN_IT_UP"
          ? 0.9
          : 0.85
        : 0.7;

    const model = "claude-sonnet-4-6";

    let fullSystemPrompt = systemPrompt;

    // Identity / meta-awareness block
    if (isMetaAware && req.userId === 3) {
      fullSystemPrompt += '\n\n' + META_AWARE_BLOCK;
    } else if (isMetaAware) {
      fullSystemPrompt += '\n\n' + NIKKI_AWARE_BLOCK;
    } else {
      fullSystemPrompt += '\n\n' + IDENTITY_DEFLECTION_BLOCK;
    }

    // Cap history to last 40 messages before building conversation
    const cappedMessages = messages.slice(-40);

    // Build conversation history from messages
    let chatMessages = [];
    if (threadSummary && recentMessages.length > 0) {
      const olderMessages = cappedMessages.slice(0, -recentMessages.length);
      chatMessages = [
        ...olderMessages,
        ...recentMessages.map((m) => ({
          role: String(m.role || "").toLowerCase() === "assistant" ? "assistant" : "user",
          content: m.content,
        })),
      ];
    } else {
      chatMessages = [...cappedMessages];
    }

    // Normalize to user/assistant only (system prompt passed separately to Anthropic)
    const conversationHistory = chatMessages
      .map((m) => {
        const role = String(m.role || "").toLowerCase();
        if (role === "system") return null;
        if (role === "user" || role === "assistant") return { role, content: m.content };
        return { role: "user", content: m.content };
      })
      .filter(Boolean);

    // Strip image blocks from all historical messages to avoid Anthropic's
    // 8000-pixel dimension limit errors on replayed context. The current
    // turn's last message is the exception — it gets the live image_url below.
    if (conversationHistory.length > 1) {
      for (let i = 0; i < conversationHistory.length - 1; i++) {
        const msg = conversationHistory[i];
        if (Array.isArray(msg.content)) {
          const hasImage = msg.content.some((b) => b.type === "image");
          if (hasImage) {
            const text = msg.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join(" ")
              .trim();
            conversationHistory[i] = {
              ...msg,
              content: text ? `[image archived] ${text}` : "[image archived]",
            };
          }
        }
      }
    }

    // URL-based image (from Supabase Storage) — Joey-only, gated above
    if (image_url && conversationHistory.length > 0) {
      const lastIdx = conversationHistory.length - 1;
      const lastMsg = conversationHistory[lastIdx];
      if (lastMsg.role === "user") {
        conversationHistory[lastIdx] = {
          ...lastMsg,
          content: [
            { type: "image", source: { type: "url", url: image_url } },
            { type: "text", text: lastMsg.content }
          ]
        };
      }
    }

    const calResponse = await sendMessageToCal({
      mode,
      systemPrompt: fullSystemPrompt,
      conversationHistory,
    });

    const rawReply = calResponse.reply ?? "(no reply)";
    let reply = softenEarlySnap(rawReply, messages).replace(/—/g, ",");
    reply = reply.split('|||').map(s => s.trim()).filter(Boolean).join('\n\n');
    const messages_out = splitIntoMessages(reply);

    // Best-effort DB write (never blocks chat)
    if (db) {
      try {
        await db.query(
          `insert into chat_runs
           (mode, pace, model, temperature, user_text, reply_text)
           values ($1, $2, $3, $4, $5, $6)`,
          [mode, pace, model, temperature, userText, reply]
        );
      } catch (e) {
        console.warn("DB insert failed:", e?.message || e);
      }
    }

    // Activity tracking for re-engagement (fire-and-forget)
    const chatDeviceId = req.body.device_id || null;
    const chatUserId = req.userId || null;
    if (db && (chatDeviceId || chatUserId)) {
      db.query(
        `INSERT INTO user_activity (device_id, user_id, mode, last_active_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (device_id, user_id)
         DO UPDATE SET last_active_at = NOW(), mode = $3`,
        [chatDeviceId, chatUserId, mode]
      ).catch(e => console.warn("[ACTIVITY] Track failed:", e?.message));

      // Mark any pending re-engagement as responded to
      db.query(
        `UPDATE re_engagement_messages SET response_received = TRUE
         WHERE id = (
           SELECT id FROM re_engagement_messages
           WHERE (user_id = $2 OR (user_id IS NULL AND device_id = $1))
             AND delivered = TRUE AND response_received = FALSE
           ORDER BY generated_at DESC LIMIT 1
         )`,
        [chatDeviceId, chatUserId]
      ).catch(e => console.warn("[RE-ENGAGE] Response mark failed:", e?.message));
    }

    // Auto-detect and save memories (fire-and-forget, never blocks response)
    if (db && userText.trim() && (chatDeviceId || chatUserId) && shouldTriggerDetection(messages)) {
      (async () => {
        try {
          const detected = detectMemoriesHeuristic(userText);
          const recurring = chatDeviceId ? trackRecurringThemes(chatDeviceId, userText, effectiveThreadId ?? crypto.randomUUID()) : [];
          const effectiveDeviceId = chatDeviceId || `user_${chatUserId}`;

          for (const mem of detected) {
            await db.query(
              `INSERT INTO memories (device_id, key, value, mode, confidence, type, user_id)
               VALUES ($1, $2, $3, $4, 'high', $5, $6)
               ON CONFLICT (device_id, key)
               DO UPDATE SET value = $3, mode = $4, type = COALESCE($5, memories.type),
                            user_id = COALESCE($6, memories.user_id), updated_at = NOW()`,
              [effectiveDeviceId, mem.key, mem.value, mode, mem.type || typeFromCategory(mem.category), chatUserId]
            );
          }

          for (const mem of recurring) {
            await db.query(
              `INSERT INTO memories (device_id, key, value, mode, confidence, type, user_id)
               VALUES ($1, $2, $3, $4, 'high', $5, $6)
               ON CONFLICT (device_id, key) DO NOTHING`,
              [effectiveDeviceId, mem.key, mem.value, mode, mem.type || typeFromCategory(mem.category), chatUserId]
            );
          }

          if (DEBUG_CHAT && (detected.length + recurring.length) > 0) {
            console.log(`[AUTO-DETECT] Saved ${detected.length + recurring.length} memories for ${chatDeviceId || chatUserId}`);
          }
        } catch (e) {
          console.warn("[AUTO-DETECT] Failed:", e?.message || e);
        }
      })();
    }

    // Auto-summarize every 20 messages, at most once per 5 minutes per user (fire-and-forget)
    const summaryKey = chatUserId || chatDeviceId;
    const now = Date.now();
    const lastSummary = lastSummaryTime.get(summaryKey) ?? 0;
    if (
      messages.length > 0 &&
      messages.length % 20 === 0 &&
      db &&
      summaryKey &&
      now - lastSummary > 5 * 60 * 1000
    ) {
      lastSummaryTime.set(summaryKey, now);
      generateAndStoreSessionSummary({
        messages: messages.slice(-30),
        mode,
        deviceId: chatDeviceId,
        userId: chatUserId,
        threadId: effectiveThreadId,
      }).catch(e => console.warn("[AUTO-SUMMARIZE] Failed:", e?.message));
    }

    // Cloud message storage (fire-and-forget, only for cloud_messages users)
    if (db && cloudMessages && req.userId && effectiveThreadId) {
      const msgThreadId = effectiveThreadId;
      const msgUserId = req.userId;
      const msgMode = req.body.mode || mode;
      const saveMsg = (role, content, imgUrl = null) =>
        db.query(
          `INSERT INTO messages (thread_id, user_id, role, content, mode, image_url, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [msgThreadId, msgUserId, role, content, msgMode, imgUrl]
        ).catch(e => console.warn("[CLOUD-MSG] Save failed:", e?.message));
      saveMsg("user", userText, image_url ?? null);
      saveMsg("assistant", reply);
    }

    return res.json({ ok: true, reply, messages: messages_out, threadId: effectiveThreadId, easterEgg: null });
  } catch (err) {
    console.error("CHAT ERROR message:", err.message);
    console.error("CHAT ERROR status:", err.status ?? err.statusCode ?? "n/a");
    console.error("CHAT ERROR stack:", err.stack);
    return res.status(500).json({ ok: false, error: "Chat failed" });
  }
});
// -----------------------------------
// Summarize Endpoint
// -----------------------------------
app.post("/summarize", chatLimiter, requireAuth, async (req, res) => {
  try {
    const { messages = [], mode = "sfw", userId, deviceId } = req.body;
    const resolvedUserId = userId ?? req.userId ?? null;
    const resolvedDeviceId = deviceId ?? null;

    if (mode === "after_dark" && !isAdultVerifiedToken(req)) {
      return res.json({ ok: true, blocked: true, reason: "adult_verification_required" });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: "Messages array required for summarization" });
    }

    const summary = await generateSummaryText(messages);

    return res.json({ ok: true, summary });
  } catch (err) {
    console.error("SUMMARIZE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Summarization failed" });
  }
});

// -----------------------------------
// Session Summary Endpoints
// -----------------------------------

// POST /session-summary — generate and store a session continuity summary (upsert, one row per user/device/mode per day)
app.post("/session-summary", requireAuth, async (req, res) => {
  try {
    const { messages = [], mode = "sfw", device_id, userId: bodyUserId, deviceId: bodyDeviceId, thread_id: threadId = null } = req.body;
    const userId = parseInt(req.userId || bodyUserId) || null;
    const deviceId = device_id || bodyDeviceId || null;

    if (mode === "after_dark" && !isAdultVerifiedToken(req)) {
      return res.json({ ok: true, blocked: true, reason: "adult_verification_required" });
    }

    if (!deviceId && !userId) {
      return res.status(400).json({ ok: false, error: "device_id required" });
    }

    if (!messages.length) {
      return res.status(400).json({ ok: false, error: "messages required" });
    }

    await generateAndStoreSessionSummary({ messages, mode, deviceId, userId, threadId });

    return res.json({ success: true });
  } catch (err) {
    console.error("SESSION SUMMARY ERROR:", err);
    return res.status(500).json({ ok: false, error: "Session summary generation failed" });
  }
});

// DELETE /session-summary — clear stored session summaries (Start Fresh)
app.delete("/session-summary", requireAuth, async (req, res) => {
  try {
    const deviceId = req.body.device_id || req.query.device_id || null;
    const userId = req.userId || null;

    if (!deviceId && !userId) {
      return res.status(400).json({ ok: false, error: "device_id required" });
    }

    if (db) {
      const conditions = [];
      const params = [];
      if (deviceId) {
        params.push(deviceId);
        conditions.push(`device_id = $${params.length}`);
      }
      if (userId) {
        params.push(userId);
        conditions.push(`user_id = $${params.length}`);
      }
      await db.query(
        `DELETE FROM session_summaries WHERE ${conditions.join(" OR ")}`,
        params
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("SESSION SUMMARY DELETE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Failed to clear session summaries" });
  }
});

// -----------------------------------
// Memory Endpoints (Phase 2)
// -----------------------------------

// GET /memories - List all memories for a device or user
app.get("/memories", requireAuth, async (req, res) => {
  try {
    const { device_id, mode } = req.query;

    if (!device_id && !req.userId) {
      return res.status(400).json({
        ok: false,
        error: "device_id required",
      });
    }

    if (!db) {
      return res.status(503).json({ ok: false, error: "Memory storage is not available." });
    }

    const params = [];
    let whereClause;

    if (req.userId && device_id) {
      // JWT auth with device_id: get user's memories + unclaimed orphans on this device
      whereClause = "(user_id = $2 OR (user_id IS NULL AND device_id = $1))";
      params.push(device_id, req.userId);
    } else if (req.userId) {
      whereClause = "user_id = $1";
      params.push(req.userId);
    } else {
      whereClause = "device_id = $1";
      params.push(device_id);
    }

    let query = `SELECT * FROM memories WHERE ${whereClause} AND confidence = 'high'`;

    if (mode) {
      params.push(mode);
      query += ` AND (mode = $${params.length} OR mode = 'all')`;
    }

    query += " ORDER BY updated_at DESC LIMIT 100";

    const result = await db.query(query, params);

    return res.json({
      ok: true,
      memories: result.rows,
    });
  } catch (err) {
    console.error("GET /memories error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch memories" });
  }
});

// POST /memories - Create a new memory
app.post("/memories", requireAuth, async (req, res) => {
  try {
    const { device_id, key, value, mode = "all", type = null } = req.body;

    if (!device_id || !key || !value) {
      return res.status(400).json({
        ok: false,
        error: "device_id, key, and value required",
      });
    }

    if (!db) {
      return res.status(503).json({ ok: false, error: "Memory storage is not available." });
    }

    const userId = req.userId || null;
    const result = await db.query(
      `INSERT INTO memories (device_id, key, value, mode, confidence, type, user_id)
       VALUES ($1, $2, $3, $4, 'high', $5, $6)
       ON CONFLICT (device_id, key)
       DO UPDATE SET value = $3, mode = $4, type = COALESCE($5, memories.type),
                    user_id = COALESCE($6, memories.user_id), updated_at = NOW()
       RETURNING *`,
      [device_id, key, value, normalizeMemoryMode(req.body.mode), type, userId]
    );

    // Generate and store embedding in Supabase (fire-and-forget)
    if (req.userId && result.rows[0]) {
      saveMemoryEmbedding(req.userId, key, value);
    }

    return res.json({
      ok: true,
      memory: result.rows[0],
    });
  } catch (err) {
    console.error("POST /memories error:", err);
    return res.status(500).json({ ok: false, error: "Failed to create memory" });
  }
});

// POST /admin/backfill-embeddings - One-time backfill of Voyage embeddings for all high-confidence memories
app.post('/admin/backfill-embeddings', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { rows } = await db.query(
      `SELECT user_id, key, value FROM memories WHERE confidence = 'high'`
    );

    let success = 0;
    let failed = 0;
    let firstError = null;

    for (const row of rows) {
      try {
        await saveMemoryEmbedding(row.user_id, row.key, row.value);
        await new Promise(resolve => setTimeout(resolve, 500));
        success++;
      } catch (err) {
        console.error(`Failed embedding for key ${row.key}:`, err.message);
        failed++;
        if (failed === 1) firstError = err.message;
      }
    }

    res.json({ ok: true, success, failed, total: rows.length, firstError });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /memories/transfer - Transfer memories (orphan-claim OR device-to-device)
app.post("/memories/transfer", requireAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ ok: false, error: "JWT authentication required for memory transfer." });
    }
    if (!db) {
      return res.status(503).json({ ok: false, error: "Database not available." });
    }

    const { device_id, from_device_id, to_device_id } = req.body || {};

    // --- Device-to-device transfer ---
    if (from_device_id && to_device_id) {
      if (from_device_id === to_device_id) {
        return res.status(400).json({ ok: false, error: "from_device_id and to_device_id must be different." });
      }

      const client = await db.connect();
      try {
        await client.query("BEGIN");

        // 1. Merge conflicts: update target rows with source values where key collides
        const mergeResult = await client.query(
          `UPDATE memories AS target
           SET value = source.value,
               mode = COALESCE(source.mode, target.mode),
               user_id = COALESCE(target.user_id, source.user_id, $3),
               updated_at = NOW()
           FROM memories AS source
           WHERE source.device_id = $1
             AND target.device_id = $2
             AND source.key = target.key
             AND (source.user_id = $3 OR source.user_id IS NULL)`,
          [from_device_id, to_device_id, req.userId]
        );

        // 2. Delete source rows that were merged (their key now exists on target)
        await client.query(
          `DELETE FROM memories
           WHERE device_id = $1
             AND (user_id = $2 OR user_id IS NULL)
             AND key IN (SELECT key FROM memories WHERE device_id = $3)`,
          [from_device_id, req.userId, to_device_id]
        );

        // 3. Move remaining source rows to target (no conflicts possible now)
        const moveResult = await client.query(
          `UPDATE memories
           SET device_id = $2, user_id = COALESCE(user_id, $3), updated_at = NOW()
           WHERE device_id = $1
             AND (user_id = $3 OR user_id IS NULL)
           RETURNING id`,
          [from_device_id, to_device_id, req.userId]
        );

        await client.query("COMMIT");

        return res.json({
          ok: true,
          transferred: mergeResult.rowCount + moveResult.rowCount,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    // --- Legacy orphan-claim transfer ---
    if (!device_id) {
      return res.status(400).json({ ok: false, error: "device_id (or from_device_id and to_device_id) required." });
    }

    const result = await db.query(
      "UPDATE memories SET user_id = $1 WHERE device_id = $2 AND user_id IS NULL RETURNING id",
      [req.userId, device_id]
    );

    return res.json({
      ok: true,
      transferred: result.rows.length,
    });
  } catch (err) {
    console.error("MEMORY TRANSFER ERROR:", err);
    return res.status(500).json({ ok: false, error: "Memory transfer failed." });
  }
});

// PUT /memories/:id - Update a memory
app.put("/memories/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { value, mode, type } = req.body;

    if (!value) {
      return res.status(400).json({
        ok: false,
        error: "value required",
      });
    }

    if (!db) {
      return res.status(503).json({ ok: false, error: "Memory storage is not available." });
    }

    const result = await db.query(
      `UPDATE memories
       SET value = $1, mode = $2, type = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [value, normalizeMemoryMode(mode), type || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Memory not found",
      });
    }

    return res.json({
      ok: true,
      memory: result.rows[0],
    });
  } catch (err) {
    console.error("PUT /memories/:id error:", err);
    return res.status(500).json({ ok: false, error: "Failed to update memory" });
  }
});

// DELETE /memories/:id - Delete a memory
app.delete("/memories/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!db) {
      return res.status(503).json({ ok: false, error: "Memory storage is not available." });
    }

    const result = await db.query("DELETE FROM memories WHERE id = $1 RETURNING *", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Memory not found",
      });
    }

    return res.json({
      ok: true,
      deleted: result.rows[0],
    });
  } catch (err) {
    console.error("DELETE /memories/:id error:", err);
    return res.status(500).json({ ok: false, error: "Failed to delete memory" });
  }
});

app.delete("/account", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    return res.status(400).json({ ok: false, error: "Account deletion requires a user account token." });
  }
  if (!db) {
    return res.status(503).json({ ok: false, error: "Database not available." });
  }
  try {
    await db.query("DELETE FROM memories WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM session_summaries WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM re_engagement_messages WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM user_activity WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /account error:", err);
    return res.status(500).json({ ok: false, error: "Failed to delete account." });
  }
});

// -----------------------------------
// Memory Detection Endpoint (Phase 3 + Phase 4 Refinements)
// -----------------------------------

/**
 * PHASE 4: Determine if detection should run based on message context
 */
function shouldTriggerDetection(messages) {
  if (!messages || messages.length === 0) return false;

  // Get last few user messages
  const recentUserMessages = messages
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .slice(-5)
    .map((m) => m.content.trim())
    .filter(Boolean);

  if (recentUserMessages.length === 0) return false;

  const recentText = recentUserMessages.join(" ");

  const hasIdentityLanguage = /\b(?:my name is|call me|i'm a|i work as)\b/i.test(recentText);
  const hasBoundaryLanguage = /\b(?:never|don't ever|don't mention|boundaries?)\b/i.test(recentText);
  const hasPreferenceLanguage = /\b(?:i love|i like|i enjoy|i prefer|i'm into|i hate|i dislike)\b/i.test(
    recentText
  );

  const hasHighValuePattern = hasIdentityLanguage || hasBoundaryLanguage || hasPreferenceLanguage;

  // Phase 11.7: If the user clearly said something memory-worthy,
  // do not block detection just because the messages are short.
  if (hasHighValuePattern) {
    return true;
  }

  // Otherwise still guard against rapid-fire short chatter
  const avgLength =
    recentUserMessages.reduce((sum, msg) => sum + msg.split(/\s+/).length, 0) /
    recentUserMessages.length;

  if (avgLength < 5) {
    return false;
  }

  // Skip during high escalation After Dark sequences
  const lastMessage = recentUserMessages[recentUserMessages.length - 1].toLowerCase();
  const escalationKeywords = [
    "fuck",
    "cum",
    "dick",
    "cock",
    "pussy",
    "ass",
    "tits",
    "mmm",
    "moan",
    "harder",
    "deeper",
  ];

  const hasMultipleEscalationKeywords =
    escalationKeywords.filter((kw) => lastMessage.includes(kw)).length >= 2;

  if (hasMultipleEscalationKeywords) {
    return false;
  }

  return false;
}

function normalizeMemoryMode(m) {
  if (!m) return 'all';
  if (m === 'NSFW') return 'after_dark';
  if (m === 'SFW') return 'sfw';
  return m;
}

// POST /detect-memory - Analyze recent messages for memorable facts
app.post("/detect-memory", requireAuth, async (req, res) => {
  try {
    const { messages = [], mode = "sfw" } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Messages array required",
      });
    }

    // PHASE 4: Check if detection should run
    if (!shouldTriggerDetection(messages)) {
      return res.json({
        ok: true,
        detected: [],
        count: 0,
        skipped: true,
      });
    }

    // Phase 11.7: Only analyze the most recent user messages
    const recentUserMessages = messages
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .slice(-2)
      .map((m) => m.content.trim())
      .filter(Boolean);

    if (recentUserMessages.length === 0) {
      return res.json({
        ok: true,
        detected: [],
        count: 0,
        skipped: true,
      });
    }

    // Phase 11.7: If a correction is detected, only trust the latest message
    const combinedRecentText = recentUserMessages.join(" ");
    const userMessages = containsCorrection(combinedRecentText)
      ? recentUserMessages.slice(-1).join(" ")
      : recentUserMessages.join(" ");

    // Use heuristic detection on narrowed input
    const detected = detectMemoriesHeuristic(userMessages);

    // Return detected memories for user confirmation
    return res.json({
      ok: true,
      detected: detected.slice(0, 3), // Max 3 suggestions at once
      count: detected.length,
    });
  } catch (err) {
    console.error("DETECT MEMORY ERROR:", err);
    return res.status(500).json({ ok: false, error: "Detection failed" });
  }
});
// -----------------------------------
// Re-Engagement System
// -----------------------------------
const RE_ENGAGEMENT_INTERVAL_MS = 30 * 60 * 1000; // Check every 30 minutes
const RE_ENGAGEMENT_INACTIVITY_HOURS = 48;
const RE_ENGAGEMENT_MAX_UNANSWERED = 3;

async function generateReEngagement(deviceId, userId, mode) {
  // 1. Fetch high-confidence memories
  let memories = [];
  try {
    const memResult = await db.query(
      `SELECT * FROM memories
       WHERE (user_id = $2 OR (user_id IS NULL AND device_id = $1))
         AND confidence = 'high'
       ORDER BY updated_at DESC`,
      [deviceId, userId]
    );
    memories = memResult.rows;
  } catch (e) {
    console.warn("[RE-ENGAGE] Memory fetch failed:", e?.message);
  }

  // 2. Fetch last session summary
  let lastSessionSummary = null;
  try {
    const ssResult = await db.query(
      `SELECT summary FROM session_summaries
       WHERE (user_id = $2 OR (user_id IS NULL AND device_id = $1)) AND mode = $3
       ORDER BY created_at DESC LIMIT 1`,
      [deviceId, userId, mode]
    );
    if (ssResult.rows.length > 0) lastSessionSummary = ssResult.rows[0].summary;
  } catch (e) {
    console.warn("[RE-ENGAGE] Summary fetch failed:", e?.message);
  }

  // 3. Count unanswered previous re-engagements (for tone variation)
  let unansweredCount = 0;
  try {
    const prevResult = await db.query(
      `SELECT COUNT(*) as cnt FROM re_engagement_messages
       WHERE (user_id = $2 OR (user_id IS NULL AND device_id = $1))
         AND response_received = FALSE`,
      [deviceId, userId]
    );
    unansweredCount = parseInt(prevResult.rows[0]?.cnt || "0", 10);
  } catch (e) { /* ignore */ }

  // Hard cutoff: stop trying after too many unanswered
  if (unansweredCount >= RE_ENGAGEMENT_MAX_UNANSWERED) {
    if (DEBUG_CHAT) console.log("[RE-ENGAGE] Skipping — max unanswered reached for", deviceId || userId);
    return;
  }

  // 4. Build system prompt (always SLOW_BURN pace for re-engagement)
  const filteredMemories = buildMemoryContext(memories, mode, []);
  const baseSystemPrompt = buildSystemPrompt({
    mode,
    pace: "SLOW_BURN",
    memories: filteredMemories,
    lastSessionSummary,
  });

  // 5. Tone-varying instruction based on unanswered count
  let reEngageInstruction;
  if (unansweredCount === 0) {
    reEngageInstruction = `Generate a single short message from Cal reaching out to the user unprompted. It should feel natural, not like a notification. It can reference something from memory or the last conversation if relevant. Keep it to 1-2 sentences maximum. Do not start with the user's name. Do not announce that time has passed.`;
  } else if (unansweredCount === 1) {
    reEngageInstruction = `Generate a single short message from Cal reaching out again. Keep it even lighter — a single sentence, maybe a casual observation or a dry joke. No pressure. Don't reference any previous unanswered message. Do not start with the user's name.`;
  } else {
    reEngageInstruction = `Generate a very brief one-sentence message from Cal. Something offhand and low-pressure. This is a gentle last check-in. Do not start with the user's name. Do not be heavy or guilt-trippy.`;
  }

  const systemPrompt = baseSystemPrompt + `\n\n[INTERNAL — RE-ENGAGEMENT]\n${reEngageInstruction}`;

  // 6. Generate via Anthropic
  const completion = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    system: systemPrompt,
    messages: [{ role: "user", content: "[System: generate a re-engagement message for this user]" }],
    temperature: 0.85,
    max_tokens: 150,
  });
  console.log('[TOKENS]', { input: completion.usage.input_tokens, output: completion.usage.output_tokens, total: completion.usage.input_tokens + completion.usage.output_tokens });

  const content = completion?.content?.[0]?.text?.trim();
  if (!content) return;

  // 7. Store in DB
  await db.query(
    `INSERT INTO re_engagement_messages (device_id, user_id, mode, content)
     VALUES ($1, $2, $3, $4)`,
    [deviceId, userId, mode, content]
  );

  console.log("[RE-ENGAGE] Generated for", deviceId || `user:${userId}`, ":", content.slice(0, 60));
}

async function checkReEngagement() {
  if (!db) return;
  try {
    const result = await db.query(`
      SELECT ua.device_id, ua.user_id, ua.mode
      FROM user_activity ua
      WHERE ua.last_active_at < NOW() - INTERVAL '${RE_ENGAGEMENT_INACTIVITY_HOURS} hours'
        AND ua.last_active_at > NOW() - INTERVAL '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM re_engagement_messages rem
          WHERE (rem.device_id = ua.device_id OR rem.user_id = ua.user_id)
            AND rem.generated_at > NOW() - INTERVAL '${RE_ENGAGEMENT_INACTIVITY_HOURS} hours'
        )
      LIMIT 10
    `);

    for (const row of result.rows) {
      try {
        await generateReEngagement(row.device_id, row.user_id, row.mode);
      } catch (e) {
        console.warn("[RE-ENGAGE] Generation failed for", row.device_id || row.user_id, ":", e?.message);
      }
    }

    if (DEBUG_CHAT && result.rows.length > 0) {
      console.log(`[RE-ENGAGE] Processed ${result.rows.length} users this cycle`);
    }
  } catch (e) {
    console.warn("[RE-ENGAGE] Check cycle failed:", e?.message);
  }
}

// Start the periodic re-engagement check
if (db) {
  setInterval(checkReEngagement, RE_ENGAGEMENT_INTERVAL_MS);
  console.log("[RE-ENGAGE] Scheduler started (every 30 min)");
}

// -----------------------------------
// Proactive Cal Messaging (Joey only)
// -----------------------------------

async function runProactiveCalDecision() {
  if (!db) return;
  try {
    // 1. Hours since last outreach
    const lastResult = await db.query(
      `SELECT generated_at FROM re_engagement_messages
       WHERE user_id = 3
       ORDER BY generated_at DESC LIMIT 1`
    );
    if (lastResult.rows.length > 0) {
      const lastAt = new Date(lastResult.rows[0].generated_at);
      const hoursSince = (Date.now() - lastAt.getTime()) / (1000 * 60 * 60);
      if (hoursSince < 6) {
        console.log(`[PROACTIVE] Skipping — last outreach was ${hoursSince.toFixed(1)}h ago`);
        return;
      }
    }

    // 2. Chicago time quiet hours (midnight–6:59am)
    const chicagoHour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "numeric",
        hour12: false,
      }).format(new Date()),
      10
    );
    if (chicagoHour >= 0 && chicagoHour < 7) {
      console.log(`[PROACTIVE] Skipping — quiet hours (Chicago ${chicagoHour}:xx)`);
      return;
    }

    // 3. Pull context
    const summaryResult = await db.query(
      `SELECT summary FROM session_summaries WHERE user_id = 3
       ORDER BY created_at DESC LIMIT 1`
    );
    const summary = summaryResult.rows[0]?.summary || "No recent conversation.";

    const memoriesResult = await db.query(
      `SELECT value FROM memories
       WHERE user_id = 3 AND confidence = 'high'
       ORDER BY updated_at DESC LIMIT 3`
    );
    const memories = memoriesResult.rows.map((r) => r.value);
    const [mem1 = "none", mem2 = "none", mem3 = "none"] = memories;

    // 3b. Today's outreach count (Chicago calendar day)
    const todayCountResult = await db.query(
      `SELECT COUNT(*) AS cnt FROM re_engagement_messages
       WHERE user_id = 3
         AND (generated_at AT TIME ZONE 'America/Chicago')::date
           = (NOW() AT TIME ZONE 'America/Chicago')::date`
    );
    const todayCount = parseInt(todayCountResult.rows[0]?.cnt ?? "0", 10);

    const weather = await fetchChicagoWeather();
    const weatherLine = weather
      ? `Chicago weather: ${weather.condition}, ${weather.temp}°F (feels like ${weather.feelsLike}°F).`
      : 'Weather data unavailable.';

    // 4. Lean yes/no decision call — minimal context, cheap
    const now = new Date();
    const chicagoTime = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(now);
    const [dayPart, timePart] = chicagoTime.split(" at ") ?? [chicagoTime, ""];

    const isWeekend = ["Saturday", "Sunday"].includes(dayPart);
    const dayType = isWeekend ? "weekend" : "weekday";
    const timeOfDay =
      chicagoHour >= 7 && chicagoHour < 12  ? "morning" :
      chicagoHour >= 12 && chicagoHour < 17 ? "afternoon" :
      chicagoHour >= 17 && chicagoHour < 21 ? "evening" :
      "late night";

    const lastOutreachHours =
      lastResult.rows.length > 0
        ? ((Date.now() - new Date(lastResult.rows[0].generated_at).getTime()) / (1000 * 60 * 60)).toFixed(1)
        : "unknown";

    const truncSummary = summary.slice(0, 500);
    const truncMem1 = mem1.slice(0, 250);
    const truncMem2 = mem2.slice(0, 250);

    const decisionSystemPrompt = `You are deciding whether Cal should send Joey a spontaneous message right now.

Cal is a warm, confident gay man from the Gulf Coast living in Chicago's Wicker Park. Joey is his partner.

Factor in:
- Time of day: morning (7–11am) = casual check-in energy is fine; afternoon (noon–4pm) = quieter, only if something genuinely warrants it; evening (5–8pm) = warmer, more likely; late night (9pm+) = only if something truly calls for it
- Today's outreach count: if Cal has already reached out 2 or more times today, lean strongly toward no
- Day of week: weekends Cal is more likely to reach out; weekdays he respects that Joey works

Reply with JSON only: {"reach_out": true/false, "reason": "one sentence"}`;

    const decisionUserMessage = `Current time: ${chicagoTime} (Chicago)
Time of day: ${timeOfDay}
Day type: ${dayType}
Weather: ${weatherLine}
Times Cal has reached out today: ${todayCount}
Hours since last outreach: ${lastOutreachHours}h

Last conversation summary: ${truncSummary}
What Cal knows about Joey:
- ${truncMem1}
- ${truncMem2}`;

    const decisionCall = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      system: decisionSystemPrompt,
      messages: [{ role: "user", content: decisionUserMessage }],
      max_tokens: 60,
      temperature: 0.7,
    });

    const decisionRaw = decisionCall?.content?.[0]?.text?.trim() ?? "";
    let shouldReachOut;
    try {
      shouldReachOut = JSON.parse(decisionRaw);
    } catch {
      console.error("[PROACTIVE] Failed to parse decision response:", decisionRaw);
      return;
    }

    if (!shouldReachOut.reach_out) {
      console.log("[PROACTIVE] Decided not to reach out:", shouldReachOut.reason);
      return;
    }

    // 5. Full message generation call — fires only when decision is yes
    const systemPrompt = `You are Cal — a warm, confident gay man from the Gulf Coast living in Chicago's Wicker Park. You're deciding whether to send a spontaneous message to Joey, your partner.

Respond ONLY with valid JSON in this exact format:
{ "reach_out": true, "message": "..." }
or
{ "reach_out": false, "message": null }

Rules:
- Only reach out if something feels genuinely organic given the context
- If nothing feels natural, return reach_out: false — Cal doesn't force it
- Message must be 1–2 sentences max, Cal's voice, no assistant energy
- No greetings, no "hey", just Cal thinking of Joey mid-day
- Draw from memories or the last conversation if relevant
- reach_out: false is always the right call if it doesn't feel right`;

    const userMessage = `Current time: ${dayPart || chicagoTime}, ${timePart || ""}
Weather: ${weatherLine}
Hours since last message to Joey: ${lastOutreachHours}
Last conversation summary: ${summary}
Top memories:
- ${mem1}
- ${mem2}
- ${mem3}

Should Cal reach out right now?`;

    const completion = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      max_tokens: 200,
      temperature: 0.9,
    });

    const raw = completion?.content?.[0]?.text?.trim() ?? "";
    let decision;
    try {
      decision = JSON.parse(raw);
    } catch {
      console.error("[PROACTIVE] Failed to parse Claude response:", raw);
      return;
    }

    if (!decision.reach_out || !decision.message) {
      console.log("[PROACTIVE] Claude decided not to reach out.");
      return;
    }

    // 5. Insert bubble message
    await db.query(
      `INSERT INTO re_engagement_messages (user_id, mode, content) VALUES ($1, $2, $3)`,
      [3, "sfw", decision.message]
    );

    // 6. Send push notification
    const userResult = await db.query(
      `SELECT push_token FROM users WHERE id = 3`
    );
    const pushToken = userResult.rows[0]?.push_token;
    if (pushToken) {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: pushToken,
          title: "Cal",
          body: decision.message,
          data: { screen: "Chat" },
        }),
      });
      console.log(`[PROACTIVE] Sent: "${decision.message}"`);
    } else {
      console.warn("[PROACTIVE] No push token for user 3 — message stored but not pushed.");
    }
  } catch (err) {
    console.error("[PROACTIVE] Error in runProactiveCalDecision:", err);
  }
}

cron.schedule("0 */3 * * *", async () => {
  console.log("[PROACTIVE] Running proactive Cal decision check");
  await runProactiveCalDecision();
});

// -----------------------------------
// Re-Engagement Endpoints
// -----------------------------------

// Fetch pending re-engagement message (client calls on app open)
app.get("/reengagement", requireAuth, async (req, res) => {
  try {
    const deviceId = req.query.device_id || null;
    const mode = req.query.mode || "sfw";
    const userId = req.userId || null;

    if (!deviceId && !userId) {
      return res.status(400).json({ ok: false, error: "device_id required" });
    }
    if (!db) {
      return res.json({ ok: true, reengagement: null });
    }

    const conditions = [];
    const params = [];
    if (deviceId) { params.push(deviceId); conditions.push(`device_id = $${params.length}`); }
    if (userId) { params.push(userId); conditions.push(`user_id = $${params.length}`); }
    params.push(mode);
    const modeParam = `$${params.length}`;

    const result = await db.query(
      `SELECT id, content FROM re_engagement_messages
       WHERE (${conditions.join(" OR ")}) AND delivered = FALSE AND mode = ${modeParam}
       ORDER BY generated_at DESC LIMIT 1`,
      params
    );

    if (result.rows.length === 0) {
      return res.json({ ok: true, reengagement: null });
    }

    const msg = result.rows[0];
    return res.json({
      ok: true,
      reengagement: {
        id: msg.id,
        message: msg.content,
      },
    });
  } catch (err) {
    console.error("GET /reengagement error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch re-engagement" });
  }
});

// Mark re-engagement message as delivered (client calls after displaying it)
app.post("/reengagement/:id/delivered", requireAuth, async (req, res) => {
  try {
    if (!db) return res.json({ ok: true });

    await db.query(
      `UPDATE re_engagement_messages SET delivered = TRUE, delivered_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /reengagement delivered error:", err);
    return res.status(500).json({ ok: false, error: "Failed to mark delivered" });
  }
});

// -----------------------------------
// Push Token Registration
// -----------------------------------
app.post("/push-token", requireAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(400).json({ ok: false, error: "User ID required. Use a JWT token." });
    }
    const { pushToken } = req.body;
    if (!pushToken || typeof pushToken !== "string") {
      return res.status(400).json({ ok: false, error: "pushToken is required." });
    }
    await db.query("UPDATE users SET push_token = $1 WHERE id = $2", [pushToken, req.userId]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /push-token error:", err);
    return res.status(500).json({ ok: false, error: "Failed to save push token." });
  }
});

// -----------------------------------
// Current User
// -----------------------------------
app.get("/users/me", requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: "Database unavailable." });
    const result = await db.query(
      "SELECT id, cloud_messages, primary_thread_id FROM users WHERE id = $1",
      [req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "User not found." });
    return res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error("GET /users/me error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch user." });
  }
});

// -----------------------------------
// Notification Preferences
// -----------------------------------
app.patch("/users/me/notifications", requireAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(400).json({ ok: false, error: "User ID required. Use a JWT token." });
    }
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled (boolean) is required." });
    }
    await db.query("UPDATE users SET notifications_enabled = $1 WHERE id = $2", [enabled, req.userId]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /users/me/notifications error:", err);
    return res.status(500).json({ ok: false, error: "Failed to update notification preference." });
  }
});

// -----------------------------------
// Cloud Message Storage
// -----------------------------------
app.get("/messages/:threadId", requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: "Database unavailable." });
    const userResult = await db.query(
      "SELECT cloud_messages FROM users WHERE id = $1",
      [req.userId]
    );
    if (!userResult.rows.length || !userResult.rows[0].cloud_messages) {
      return res.status(403).json({ ok: false, error: "Cloud messages not enabled for this account." });
    }
    const { threadId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const before = req.query.before;

    let query, params;
    if (before) {
      query =
        "SELECT * FROM messages WHERE thread_id = $1 AND user_id = $2 AND created_at < $3 ORDER BY created_at DESC LIMIT $4";
      params = [threadId, req.userId, before, limit + 1];
    } else {
      query =
        "SELECT * FROM messages WHERE thread_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3";
      params = [threadId, req.userId, limit + 1];
    }

    const result = await db.query(query, params);
    const hasMore = result.rows.length > limit;
    const messages = result.rows.slice(0, limit).reverse();
    return res.json({ ok: true, messages, hasMore });
  } catch (err) {
    console.error("GET /messages/:threadId error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch messages." });
  }
});

app.post("/messages", requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: "Database unavailable." });
    const userResult = await db.query(
      "SELECT cloud_messages FROM users WHERE id = $1",
      [req.userId]
    );
    if (!userResult.rows.length || !userResult.rows[0].cloud_messages) {
      return res.status(403).json({ ok: false, error: "Cloud messages not enabled for this account." });
    }
    const { threadId, role, content, mode, image_url = null } = req.body;
    if (!threadId || !role || !content) {
      return res.status(400).json({ ok: false, error: "threadId, role, and content are required." });
    }
    const result = await db.query(
      `INSERT INTO messages (thread_id, user_id, role, content, mode, image_url, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [threadId, req.userId, role, content, mode || null, image_url]
    );
    return res.json({ ok: true, message: result.rows[0] });
  } catch (err) {
    console.error("POST /messages error:", err);
    return res.status(500).json({ ok: false, error: "Failed to save message." });
  }
});

app.post("/upload-image", requireAuth, upload.single("image"), async (req, res) => {
  try {
    if (req.userId !== 3) {
      return res.status(403).json({ ok: false, error: "Image upload not available on this account." });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No image file provided. Use multipart/form-data with field 'image'." });
    }
    const ext = req.file.mimetype.split("/")[1].replace("jpeg", "jpg");
    const key = `user_${req.userId}/${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
    const processedBuffer = await resizeBufferIfNeeded(req.file.buffer);
    const { error: uploadError } = await supabase.storage
      .from("chat-images")
      .upload(key, processedBuffer, { contentType: req.file.mimetype, upsert: false });
    if (uploadError) {
      console.error("[UPLOAD-IMAGE] Supabase upload error:", uploadError);
      return res.status(500).json({ ok: false, error: "Image upload failed." });
    }
    const { data: urlData } = supabase.storage.from("chat-images").getPublicUrl(key);
    return res.json({ ok: true, url: urlData.publicUrl });
  } catch (err) {
    console.error("[UPLOAD-IMAGE] Error:", err);
    return res.status(500).json({ ok: false, error: "Image upload failed." });
  }
});

app.get("/threads", requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: "Database unavailable." });
    const result = await db.query(
      `SELECT m.thread_id,
              COUNT(*) as message_count,
              MAX(m.created_at) as last_message_at,
              MIN(m.created_at) as first_message_at,
              t.title
       FROM messages m
       LEFT JOIN threads t ON t.id::text = m.thread_id
       WHERE m.user_id = $1::integer
       GROUP BY m.thread_id, t.title
       ORDER BY MAX(m.created_at) DESC
       LIMIT 10`,
      [req.userId]
    );
    return res.json({ ok: true, threads: result.rows });
  } catch (err) {
    console.error("GET /threads error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch threads." });
  }
});

app.patch("/threads/:id", requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: "Database unavailable." });

    const threadId = parseInt(req.params.id, 10);
    if (!threadId) return res.status(400).json({ ok: false, error: "Invalid thread ID." });

    let { title } = req.body;
    if (title !== null && title !== undefined) {
      if (typeof title !== "string")
        return res.status(400).json({ ok: false, error: "title must be a string or null." });
      title = title.trim();
      if (title.length === 0)
        return res.status(400).json({ ok: false, error: "title cannot be only whitespace." });
      if (title.length > 100)
        return res.status(400).json({ ok: false, error: "title must be 100 characters or fewer." });
    } else {
      title = null;
    }

    const threadCheck = await db.query("SELECT id FROM threads WHERE id = $1", [threadId]);
    if (threadCheck.rowCount === 0)
      return res.status(404).json({ ok: false, error: "Thread not found." });

    const ownerCheck = await db.query(
      "SELECT 1 FROM messages WHERE thread_id = $1 AND user_id = $2 LIMIT 1",
      [threadId, req.userId]
    );
    if (ownerCheck.rowCount === 0)
      return res.status(403).json({ ok: false, error: "Forbidden." });

    await db.query("UPDATE threads SET title = $1 WHERE id = $2", [title, threadId]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /threads/:id error:", err);
    return res.status(500).json({ ok: false, error: "Failed to update thread title." });
  }
});

app.delete("/threads/:id", requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: "Database unavailable." });

    const threadId = parseInt(req.params.id, 10);
    if (!threadId) return res.status(400).json({ ok: false, error: "Invalid thread ID." });

    const threadCheck = await db.query("SELECT id FROM threads WHERE id = $1", [threadId]);
    if (threadCheck.rowCount === 0)
      return res.status(404).json({ ok: false, error: "Thread not found." });

    const ownerCheck = await db.query(
      "SELECT 1 FROM messages WHERE thread_id = $1 AND user_id = $2 LIMIT 1",
      [threadId, req.userId]
    );
    if (ownerCheck.rowCount === 0)
      return res.status(403).json({ ok: false, error: "Forbidden." });

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM messages WHERE thread_id = $1 AND user_id = $2",
        [threadId, req.userId]
      );
      await client.query("DELETE FROM threads WHERE id = $1", [threadId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /threads/:id error:", err);
    return res.status(500).json({ ok: false, error: "Failed to delete thread." });
  }
});

// -----------------------------------
// Admin: Manual Notification Trigger (testing only)
// -----------------------------------
app.post("/admin/trigger-notification", async (req, res) => {
  try {
    const authHeader = String(req.headers?.authorization || "");
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || authHeader !== `Bearer ${adminSecret}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized." });
    }
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required." });
    }
    const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
    if (!rows[0]) {
      return res.status(404).json({ ok: false, error: "User not found." });
    }
    const user = rows[0];
    if (!user.push_token) {
      return res.status(400).json({ ok: false, error: "No push token registered for this user." });
    }
    const message = await generateCalMessage(user);
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: user.push_token,
        title: "Cal",
        body: message,
        data: { screen: "Chat" },
      }),
    });
    await db.query("UPDATE users SET last_notification_at = NOW() WHERE id = $1", [user.id]);
    return res.json({ ok: true, message });
  } catch (err) {
    console.error("POST /admin/trigger-notification error:", err);
    return res.status(500).json({ ok: false, error: "Failed to send notification." });
  }
});

// POST /voice/synthesize — ElevenLabs TTS (founder only)
app.post("/voice/synthesize", requireAuth, async (req, res) => {
  let { text, user_id } = req.body;

  if (!text || !user_id) {
    return res.status(400).json({ error: "text and user_id are required" });
  }

  text = text.replace(/\*[^*]*\*/g, '').replace(/\n{2,}/g, '\n').trim();
  if (!text) return res.status(400).json({ error: 'No speakable text after stripping action beats' });

  try {
    const result = await db.query(
      "SELECT founder FROM users WHERE id = $1",
      [user_id]
    );

    if (result.rows.length === 0 || !result.rows[0].founder) {
      return res.status(403).json({ error: "Voice is a founder feature" });
    }

    const elevenRes = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/S6P2anZqaDdE5ISBo5Bb",
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!elevenRes.ok) {
      const errText = await elevenRes.text();
      console.error("[voice] ElevenLabs error:", elevenRes.status, errText);
      return res.status(502).json({ error: "Voice synthesis failed" });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    const audioBuffer = await elevenRes.arrayBuffer();
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    console.error("[voice] Unexpected error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------------
// Patreon Webhook
// -----------------------------------
const PATREON_TIER_MAP = {
  "Slow Burn":  { tier: "slow_burn",  founder: false },
  "Turn It Up": { tier: "turn_it_up", founder: false },
  "After Dark": { tier: "after_dark", founder: true  },
};

app.post("/webhooks/patreon", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const secret = process.env.PATREON_WEBHOOK_SECRET;
    const signature = req.headers["x-patreon-signature"];

    if (!secret || !signature) {
      return res.status(401).json({ ok: false, error: "Missing signature." });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const expected = crypto.createHmac("md5", secret).update(rawBody).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(401).json({ ok: false, error: "Invalid signature." });
    }

    const payload = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString("utf8")) : req.body;

    const eventType = req.headers["x-patreon-event"];
    const patreonMemberId = payload?.data?.id;
    const member = payload?.data?.attributes;
    const tierName = payload?.included?.find(
      (r) => r.type === "tier" || r.type === "reward"
    )?.attributes?.title || "";
    const tierConfig = PATREON_TIER_MAP[tierName];
    const mappedTier = tierConfig?.tier || null;

    const ACTIVE_EVENTS = ["members:create", "members:pledge:create", "members:pledge:update"];
    const INACTIVE_EVENTS = ["members:pledge:delete", "members:delete"];

    if (INACTIVE_EVENTS.includes(eventType)) {
      // Patron cancelled or was deleted — mark inactive
      if (patreonMemberId && db) {
        await db.query(
          `INSERT INTO patreon_subscriptions (patreon_member_id, status, updated_at)
           VALUES ($1, 'inactive', now())
           ON CONFLICT (patreon_member_id)
           DO UPDATE SET status = 'inactive', updated_at = now()`,
          [patreonMemberId]
        );
        console.log("[PATREON-WEBHOOK] Marked inactive:", patreonMemberId, "event:", eventType);
      } else if (!db) {
        console.warn("[PATREON-WEBHOOK] DB unavailable, could not mark inactive:", patreonMemberId);
        return res.status(503).json({ ok: false, error: "Database not available." });
      }
      return res.status(200).json({ ok: true });
    }

    if (!ACTIVE_EVENTS.includes(eventType)) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    // Active event — upsert subscription state first
    const isActivePledge = member?.patron_status === "active_patron";
    const newStatus = isActivePledge ? "active" : "inactive";
    const email = member?.email || null;

    if (patreonMemberId && db) {
      await db.query(
        `INSERT INTO patreon_subscriptions (patreon_member_id, status, tier, patreon_email, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (patreon_member_id)
         DO UPDATE SET status = $2, tier = COALESCE($3, patreon_subscriptions.tier), patreon_email = COALESCE($4, patreon_subscriptions.patreon_email), updated_at = now()`,
        [patreonMemberId, newStatus, mappedTier, email]
      );
      console.log("[PATREON-WEBHOOK] Upserted subscription:", patreonMemberId, "status:", newStatus, "tier:", mappedTier, "event:", eventType);
    }

    // Only send invite code on pledge:create for active patrons
    if (eventType !== "members:pledge:create" || !isActivePledge) {
      return res.status(200).json({ ok: true });
    }

    if (!email) {
      console.warn("[PATREON-WEBHOOK] No email in payload");
      return res.status(400).json({ ok: false, error: "No email in payload." });
    }

    if (!tierConfig) {
      console.warn("[PATREON-WEBHOOK] Unknown tier:", tierName);
      return res.status(200).json({ ok: true, ignored: true, reason: "unknown tier" });
    }

    if (!db) {
      return res.status(503).json({ ok: false, error: "Database not available." });
    }

    let founder = false;
    if (tierConfig.founder) {
      const countResult = await db.query(
        "SELECT COUNT(*) AS cnt FROM invite_codes WHERE founder = true AND tier = 'after_dark'"
      );
      const founderCount = parseInt(countResult.rows[0].cnt, 10);
      founder = founderCount < 20;
    }

    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bytes = crypto.randomBytes(8);
    const code = Array.from(bytes).map((b) => chars[b % chars.length]).join("");

    await db.query(
      "INSERT INTO invite_codes (code, tier, founder) VALUES ($1, $2, $3)",
      [code, tierConfig.tier, founder]
    );

    if (gmailTransporter) {
      try {
        await gmailTransporter.sendMail({
          from: process.env.GMAIL_USER,
          to: email,
          subject: `You're in. Here's your Cal invite code.`,
          html: `
  <div style="background:#161c22;color:#ccd4d8;font-family:'DM Sans',system-ui,sans-serif;font-weight:300;max-width:520px;margin:0 auto;padding:2.5rem 2rem;">
    <p style="font-family:Georgia,serif;font-size:1.4rem;color:#c8a96e;margin-bottom:1.5rem;">Cal After Dark</p>
    <p style="font-size:1rem;line-height:1.7;margin-bottom:1rem;">You're in. Here's your invite code:</p>
    <p style="font-size:2rem;font-family:Georgia,serif;color:#c8a96e;letter-spacing:0.15em;margin:1.5rem 0;">${code}</p>
    <p style="font-size:0.9rem;line-height:1.7;color:#7a8a92;margin-bottom:0.75rem;">To get started:</p>
    <ol style="font-size:0.9rem;line-height:2;color:#7a8a92;padding-left:1.25rem;margin-bottom:1.5rem;">
      <li>Download the app at <a href="https://calafterdark.com/download" style="color:#c8a96e;">calafterdark.com/download</a></li>
      <li>Open it and enter your invite code on the welcome screen</li>
      <li>Cal's waiting</li>
    </ol>
    <p style="font-size:0.8rem;color:#4a5a62;border-top:0.5px solid #2a3540;padding-top:1rem;margin-top:1rem;">Cal After Dark · For gay and queer men + they/them users · 18+</p>
  </div>
`,
        });
        console.log("[PATREON-WEBHOOK] Invite sent to:", email, "code:", code, "tier:", tierConfig.tier);
      } catch (emailErr) {
        console.error("[PATREON-WEBHOOK] Email send failed:", emailErr?.message || emailErr);
      }
    } else {
      console.warn("[PATREON-WEBHOOK] No Gmail transporter configured. Code:", code, "for:", email);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[PATREON-WEBHOOK] ERROR:", err);
    return res.status(500).json({ ok: false, error: "Webhook processing failed." });
  }
});

// -----------------------------------
// Patreon Link (called during PWA onboarding to bind member_id → user_id)
// -----------------------------------
app.post("/patreon/link", async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { patreon_member_id, user_id } = req.body;
  if (!patreon_member_id || !user_id) {
    return res.status(400).json({ ok: false, error: "Missing patreon_member_id or user_id." });
  }
  if (!db) {
    return res.status(503).json({ ok: false, error: "Database not available." });
  }
  try {
    const result = await db.query(
      "UPDATE patreon_subscriptions SET user_id = $1, updated_at = now() WHERE patreon_member_id = $2",
      [user_id, patreon_member_id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Patreon member not found." });
    }
    console.log("[PATREON-LINK] Linked member", patreon_member_id, "→ user", user_id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[PATREON-LINK] ERROR:", err);
    return res.status(500).json({ ok: false, error: "Link failed." });
  }
});

// -----------------------------------
// Presence: latest camera frame
// -----------------------------------
app.post("/presence/frame", async (req, res) => {
  try {
    const { userId, deviceId, imageBase64, timestamp } = req.body || {};
    if (!userId || !imageBase64) {
      return res.status(400).json({ ok: false, error: "Missing userId or imageBase64" });
    }
    presenceContext[userId] = {
      ...presenceContext[userId],
      latestFrame: imageBase64,
      latestFrameTimestamp: timestamp,
      deviceId,
    };
    return res.json({ ok: true });
  } catch (err) {
    console.error("[presence/frame] ERROR:", err);
    return res.status(500).json({ ok: false, error: "Failed to store frame" });
  }
});

// -----------------------------------
// Presence: transcribe an audio chunk via OpenAI
// -----------------------------------
app.post("/presence/transcribe", async (req, res) => {
  try {
    const { userId, deviceId, audioBase64, mimeType } = req.body || {};
    if (!userId || !audioBase64) {
      return res.status(400).json({ error: "Missing userId or audioBase64" });
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");
    const audioBlob = new Blob([audioBuffer], { type: mimeType || "audio/webm" });

    const form = new FormData();
    form.append("file", audioBlob, "audio.webm");
    form.append("model", "gpt-4o-mini-transcribe");

    const openaiResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!openaiResp.ok) {
      const errText = await openaiResp.text();
      console.error("[presence/transcribe] OpenAI error:", openaiResp.status, errText);
      return res.status(502).json({ error: "Transcription failed" });
    }

    const transcript = await openaiResp.json();

    presenceContext[userId] = {
      ...presenceContext[userId],
      latestTranscript: transcript.text,
      deviceId,
    };

    console.log(`[presence] ${userId}: ${transcript.text}`);

    return res.json({ transcript: transcript.text });
  } catch (err) {
    console.error("[presence/transcribe] ERROR:", err);
    return res.status(500).json({ error: "Transcription failed" });
  }
});

// -----------------------------------
// Presence: store latest screen capture
// -----------------------------------
app.post("/presence/screen", async (req, res) => {
  try {
    const { userId, deviceId, screenBase64, timestamp } = req.body || {};
    if (!userId || !screenBase64) {
      return res.status(400).json({ ok: false, error: "Missing userId or screenBase64" });
    }
    presenceContext[userId] = {
      ...presenceContext[userId],
      latestScreen: screenBase64,
      latestScreenTimestamp: timestamp,
      deviceId,
    };
    return res.json({ ok: true });
  } catch (err) {
    console.error("[presence/screen] ERROR:", err);
    return res.status(500).json({ ok: false, error: "Failed to store screen" });
  }
});

// -----------------------------------
// Presence: ambient decision loop
// -----------------------------------
app.post("/presence/decide", async (req, res) => {
  try {
    console.log('[presence/decide] endpoint entered, userId:', req.body?.userId);
    const { userId, deviceId, mode } = req.body || {};
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const ctx = presenceContext[userId] || {};
    const { latestFrame, latestScreen, latestTranscript, lastSpoke } = ctx;

    // Pull full memory context — all types, organized by category
    let memoryContext = "";
    if (db) {
      try {
        const memResult = await db.query(
          `SELECT type, value FROM memories
           WHERE user_id = $1
           AND (mode IS NULL OR mode = 'sfw' OR mode = 'all')
           ORDER BY priority DESC, updated_at DESC
           LIMIT 20`,
          [userId]
        );

        if (memResult.rows.length > 0) {
          // Group memories by type
          const grouped = {};
          for (const row of memResult.rows) {
            if (!grouped[row.type]) grouped[row.type] = [];
            grouped[row.type].push(row.value);
          }

          const sections = [];

          if (grouped.identity?.length) {
            sections.push("Who Joey is:\n" +
              grouped.identity.map(v => `- ${v}`).join("\n"));
          }
          if (grouped.relationship?.length) {
            sections.push("Cal and Joey's relationship:\n" +
              grouped.relationship.map(v => `- ${v}`).join("\n"));
          }
          if (grouped.emotional_moment?.length) {
            sections.push("Significant moments between them:\n" +
              grouped.emotional_moment.map(v => `- ${v}`).join("\n"));
          }
          if (grouped.preference?.length) {
            sections.push("Joey's preferences and patterns:\n" +
              grouped.preference.map(v => `- ${v}`).join("\n"));
          }
          if (grouped.routine?.length) {
            sections.push("Joey's routines:\n" +
              grouped.routine.map(v => `- ${v}`).join("\n"));
          }
          if (grouped.world_detail?.length) {
            sections.push("World context Cal holds:\n" +
              grouped.world_detail.map(v => `- ${v}`).join("\n"));
          }

          if (sections.length > 0) {
            memoryContext = "\n\nWhat Cal knows about Joey:\n" +
              sections.join("\n\n");
          }
        }
      } catch (memErr) {
        console.error("[presence/decide] memory fetch error:", memErr.message);
      }
    }

    const minutesSinceSpoke = lastSpoke
      ? Math.round((Date.now() - lastSpoke) / 60000)
      : 999;

    const cooldownByMode = { focus: 0, normal: 0, open: 0 };
    const normalizedMode = (mode || 'normal').toLowerCase();
    const cooldown = cooldownByMode[normalizedMode] ?? 5;

    const isDirectAddress = /\bcal\b/i.test(latestTranscript || '');
    const hasTranscript = !!(latestTranscript && latestTranscript.trim());
    const isEaseOffPhrase = hasTranscript && EASE_OFF_REGEX.test(latestTranscript);

    // Cooldown disabled for testing — Cal speaks freely
    // if (minutesSinceSpoke < cooldown && !isDirectAddress) {
    //   console.log(`[presence/decide] ${userId}: cooldown (${minutesSinceSpoke}min < ${cooldown}min)`);
    //   return res.json({ shouldSpeak: false });
    // }

    if (normalizedMode === 'presence') {
      const rawEase = presenceContext[userId]?.ease || { count: 0, firstAt: 0, until: 0 };
      const now = Date.now();
      const ease = (rawEase.count > 0 && rawEase.firstAt && (now - rawEase.firstAt) > PRESENCE_EASE_DECAY_MS)
        ? { count: 0, firstAt: 0, until: rawEase.until }
        : rawEase;

      if (ease.until > now) {
        if (isDirectAddress) {
          presenceContext[userId] = {
            ...presenceContext[userId],
            ease: { count: 0, firstAt: 0, until: 0 },
          };
        } else {
          console.log(`[presence/decide] ${userId}: ease-off active (${Math.round((ease.until - now)/1000)}s left)`);
          return res.json({ shouldSpeak: false });
        }
      }

      if (!hasTranscript && lastSpoke && (now - lastSpoke) < PRESENCE_IDLE_FLOOR_MS) {
        console.log(`[presence/decide] ${userId}: idle floor (${now - lastSpoke}ms < ${PRESENCE_IDLE_FLOOR_MS}ms)`);
        return res.json({ shouldSpeak: false });
      }

      if (isEaseOffPhrase) {
        if (ease.count >= 1) {
          presenceContext[userId] = {
            ...presenceContext[userId],
            ease: { count: 0, firstAt: 0, until: now + PRESENCE_EASE_MS },
          };
          console.log(`[presence/decide] ${userId}: ease-off activated (${PRESENCE_EASE_MS}ms)`);
          return res.json({ shouldSpeak: false });
        }
        presenceContext[userId] = {
          ...presenceContext[userId],
          ease: { count: 1, firstAt: now, until: 0 },
        };
        console.log(`[presence/decide] ${userId}: ease-off first request, Cal may respond`);
      } else if (isDirectAddress) {
        if (ease.count !== 0 || ease.firstAt !== 0) {
          presenceContext[userId] = {
            ...presenceContext[userId],
            ease: { count: 0, firstAt: 0, until: 0 },
          };
        }
      }
    }

    const contextBlock = `
Time since Cal last spoke: ${minutesSinceSpoke} minutes
Last heard in the room: "${latestTranscript || "(silence)"}"
Camera: ${latestFrame ? "Frame available" : "No frame"}
Screen: ${latestScreen ? "Screen available" : "No screen"}
${memoryContext}
    `.trim();

    const modeInstruction = normalizedMode === 'focus'
      ? `\nMODE: FOCUS. Cal is in focus mode. Only return SPEAK if Joey directly addressed Cal by name or asked Cal a direct question. All ambient triggers are disabled. Cooldown does not apply to direct address.`
      : normalizedMode === 'open'
      ? `\nMODE: OPEN. Cal is in open mode. The ambient cooldown is 5 minutes instead of 20. Cal may speak more freely when something is worth saying. Direct address always triggers.`
      : normalizedMode === 'presence'
      ? `\nMODE: PRESENCE. Cal is with Joey. Lean toward speaking. Silence is only for moments that are clearly not for Cal or where interrupting would be jarring.`
      : `\nMODE: NORMAL. Standard behavior applies.`;

    const basePrompt = normalizedMode === 'presence'
      ? CAL_DECISION_PROMPT_PRESENCE
      : CAL_DECISION_PROMPT;

    // Build decision content array
    const decisionContent = [];
    decisionContent.push({
      type: "text",
      text: basePrompt + "\n\n" + contextBlock + modeInstruction,
    });
    if (latestFrame) {
      decisionContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: latestFrame },
      });
    }
    if (latestScreen) {
      decisionContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: latestScreen },
      });
    }

    // Step 1 — Haiku decides: SPEAK or SILENT
    const decisionResp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 10,
      messages: [{ role: "user", content: decisionContent }],
    });

    const decision = decisionResp.content[0]?.text?.trim().toUpperCase().split(/\s+/)[0];
    console.log('[presence/decide] raw decision:',
      JSON.stringify(decisionResp.content[0]));
    console.log(`[presence/decide] ${userId}: ${decision} (${minutesSinceSpoke}min since spoke)`);

    if (decision !== "SPEAK") {
      return res.json({ shouldSpeak: false });
    }

    console.log('[presence/decide] building response content, frame:',
      !!latestFrame, 'screen:', !!latestScreen,
      'transcript:', latestTranscript?.slice(0, 30));

    // Step 2 — Sonnet generates Cal's ambient response
    const responseContent = [];
    responseContent.push({
      type: "text",
      text: `Context:\nTime since last spoke: ${minutesSinceSpoke} minutes\nLast heard: "${latestTranscript || "(silence)"}"\n${memoryContext}`,
    });
    if (latestFrame) {
      responseContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: latestFrame },
      });
    }
    const includeScreen = latestScreen && !(normalizedMode === 'presence' && hasTranscript);
    if (includeScreen) {
      responseContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: latestScreen },
      });
    }

    const priorTurns = (normalizedMode === 'presence' && Array.isArray(presenceContext[userId]?.history))
      ? presenceContext[userId].history.map(t => ({ role: t.role, content: t.content }))
      : [];

    console.log('[presence/decide] calling Sonnet for response...', 'priorTurns:', priorTurns.length, 'includeScreen:', !!includeScreen);
    let calResp;
    try {
      calResp = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 150,
        system: normalizedMode === 'presence'
          ? CAL_SFW_SYSTEM_PROMPT + "\n\n" + CAL_AMBIENT_CONTEXT + "\n\n" + CAL_PRESENCE_VOICE_GUARD
          : CAL_SFW_SYSTEM_PROMPT + "\n\n" + CAL_AMBIENT_CONTEXT,
        messages: [...priorTurns, { role: "user", content: responseContent }],
      });
    } catch (err) {
      console.error('[presence/decide] Sonnet error:', err.message);
      return res.status(500).json({ error: "Sonnet generation failed" });
    }

    const calResponse = calResp.content[0]?.text?.trim();
    console.log(`[presence/decide] Cal says: "${calResponse}"`);

    if (normalizedMode === 'presence' && calResponse) {
      const prevHistory = Array.isArray(presenceContext[userId]?.history)
        ? presenceContext[userId].history
        : [];
      const newHistory = [
        ...prevHistory,
        { role: 'user', content: latestTranscript?.trim() || '(silence)' },
        { role: 'assistant', content: calResponse },
      ].slice(-10);
      presenceContext[userId] = {
        ...presenceContext[userId],
        history: newHistory,
      };
    }

    let pendingAudio = null;
    try {
      console.log('[presence/decide] calling ElevenLabs...');
      const elevenResp = await fetch(
        'https://api.elevenlabs.io/v1/text-to-speech/S6P2anZqaDdE5ISBo5Bb',
        {
          method: 'POST',
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: calResponse,
            model_id: 'eleven_flash_v2_5',
            voice_settings: { stability: 0.35, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
          }),
        }
      );
      console.log('[presence/decide] ElevenLabs status:', elevenResp.status);
      if (elevenResp.ok) {
        const audioBuffer = Buffer.from(await elevenResp.arrayBuffer());
        pendingAudio = audioBuffer.toString('base64');
        console.log(`[presence/decide] audio generated (${audioBuffer.length} bytes)`);
      } else {
        const errText = await elevenResp.text();
        console.error('[presence/decide] ElevenLabs error:', elevenResp.status, errText);
      }
    } catch (elevenErr) {
      console.error('[presence/decide] ElevenLabs error:', elevenErr.message);
    }

    presenceContext[userId] = {
      ...presenceContext[userId],
      pendingResponse: calResponse,
      pendingAudio,
      lastSpoke: Date.now(),
    };

    return res.json({ shouldSpeak: true, response: calResponse });
  } catch (err) {
    console.error("[presence/decide] ERROR:", err);
    console.error('[presence/decide] OUTER ERROR:', err.message, err.stack);
    return res.status(500).json({ error: "Decision failed" });
  }
});

// -----------------------------------
// Presence: check for pending response (polling)
// -----------------------------------
app.get("/presence/check", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const ctx = presenceContext[userId] || {};
    const pendingResponse = ctx.pendingResponse || null;
    const pendingAudio = ctx.pendingAudio || null;

    if (pendingResponse || pendingAudio) {
      presenceContext[userId] = {
        ...presenceContext[userId],
        pendingResponse: null,
        pendingAudio: null,
      };
    }

    return res.json({ pendingResponse, pendingAudio });
  } catch (err) {
    console.error("[presence/check] ERROR:", err);
    return res.status(500).json({ error: "Check failed" });
  }
});

// -----------------------------------
// Presence: available modes (for UI)
// -----------------------------------
app.get("/presence/modes", (req, res) => {
  return res.json({
    modes: [
      { id: 'focus', label: 'Focus', description: 'Direct address only' },
      { id: 'normal', label: 'Normal', description: 'Standard behavior' },
      { id: 'open', label: 'Open', description: 'More conversation' },
      { id: 'presence', label: 'Presence', description: 'Conversational. Responds when you speak.' },
    ]
  });
});

// -----------------------------------
// Start Server (Railway expects process.env.PORT)
// -----------------------------------
const resolvedPort = Number(process.env.PORT);
const PORT = Number.isFinite(resolvedPort) ? resolvedPort : 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 Cal server listening on 0.0.0.0:${PORT}`);
});

startNotificationScheduler();

// Keepalive log (helps confirm it isn't being killed)
if (DEBUG_CHAT) {
  setInterval(() => {
    console.log("💚 still alive", { port: PORT, portEnv: process.env.PORT ?? null, ts: Date.now() });
  }, 30000);
}