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

import {
  CAL_SFW_SYSTEM_PROMPT,
  AFTER_DARK_SYSTEM_PROMPT,
  AFTER_DARK_BEHAVIOR_PATCH,
} from "./prompts.js";
import { sendMessageToCal, checkEasterEgg } from "./cal.js";

dotenv.config();

const { Pool } = pg;

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
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
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests, please slow down." },
});

app.use(generalLimiter);

// Toggle verbose debug without code changes (set on Railway)
const DEBUG_CHAT = String(process.env.DEBUG_CHAT || "").toLowerCase() === "true";

// Log env presence (safe - does NOT print secrets)
console.log("BOOT env check:", {
  hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
  hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
  hasJwtSecret: Boolean(process.env.JWT_SECRET),
  hasResend: Boolean(process.env.RESEND_API_KEY),
  hasWeatherKey: Boolean(process.env.OPENWEATHER_API_KEY),
  hasAdminSecret: Boolean(process.env.ADMIN_SECRET),
});

// -----------------------------------
// Chicago Weather (OpenWeatherMap)
// -----------------------------------
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
  const tz = { timeZone: "America/Chicago" };

  const dayOfWeek = now.toLocaleDateString("en-US", { ...tz, weekday: "long" });
  const dateStr = now.toLocaleDateString("en-US", { ...tz, month: "long", day: "numeric", year: "numeric" });
  const hour = parseInt(now.toLocaleTimeString("en-US", { ...tz, hour: "numeric", hour12: false }), 10);

  let timeOfDay;
  if (hour >= 5 && hour < 12) timeOfDay = "Morning";
  else if (hour >= 12 && hour < 17) timeOfDay = "Afternoon";
  else if (hour >= 17 && hour < 21) timeOfDay = "Evening";
  else timeOfDay = "Late night";

  const hourFormatted = now.toLocaleTimeString("en-US", { ...tz, hour: "numeric", minute: "2-digit", hour12: true });

  const m = parseInt(now.toLocaleDateString("en-US", { ...tz, month: "numeric" }), 10);
  let season;
  if (m >= 3 && m <= 5) season = "Spring";
  else if (m >= 6 && m <= 8) season = "Summer";
  else if (m >= 9 && m <= 11) season = "Fall";
  else season = "Winter";

  let ctx = `Current context: ${dayOfWeek}, ${dateStr}. ${timeOfDay} — ${hourFormatted}. ${season}.`;

  if (weather) {
    ctx += ` Chicago weather: ${weather.condition}, ${weather.temp}°F, feels like ${weather.feelsLike}°F.`;
  }

  return ctx;
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SESSION_SUMMARY_PROMPT = `You are generating a session continuity summary for an AI companion.
Capture in under 150 words:
- The emotional tone of the conversation
- Main topics discussed
- Any personal disclosures (name, job, situation, preferences)
- Where the conversation left off (unfinished threads, last topic)
Write in third person ("He mentioned...", "They discussed..."). Be factual and concise.`;

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
const recentTopics = new Map(); // device_id → Map<keyword, count>
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

function trackRecurringThemes(deviceId, userText) {
  const words = userText.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const meaningful = [...new Set(words.filter((w) => !COMMON_WORDS.has(w)))];

  if (!recentTopics.has(deviceId)) recentTopics.set(deviceId, new Map());
  const topicMap = recentTopics.get(deviceId);

  // Cap per-device entries at 1000
  if (topicMap.size > 1000) {
    const keys = [...topicMap.keys()];
    for (let i = 0; i < 200; i++) topicMap.delete(keys[i]);
  }

  const themes = [];
  for (const word of meaningful) {
    const count = (topicMap.get(word) || 0) + 1;
    topicMap.set(word, count);
    if (count === 3) {
      themes.push({
        category: "recurring_theme",
        type: "recurring_theme",
        key: `recurring_theme_${word}`,
        value: `He keeps bringing up "${word}" — it seems important to him`,
        confidence: "high",
      });
    }
  }
  return themes;
}

function buildSystemPrompt({ mode, pace, memories = [], lastSessionSummary = null, realtimeContext = null }) {
  let basePrompt = "";

  if (mode === "after_dark") {
    if (pace === "TURN_IT_UP" || pace === "AFTER_DARK") {
      basePrompt = `${AFTER_DARK_SYSTEM_PROMPT}\n\n${AFTER_DARK_BEHAVIOR_PATCH}`;
    } else {
      basePrompt = AFTER_DARK_SYSTEM_PROMPT;
    }
  } else {
basePrompt = CAL_SFW_SYSTEM_PROMPT;  }

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

    // PHASE 4: Natural header instead of "REMEMBERED FACTS"
    basePrompt += `\n\nThings you've learned about him over time:\n${memoryLines}`;
  }

  return basePrompt;
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
  const filtered = allMemories.filter((m) => m.mode === mode || m.mode === "all");

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

  // Selective recall: 3-5 memories max
  return sorted.slice(0, 5);
}

function isNsfwPatchApplied({ mode, pace }) {
  return mode === "after_dark" && (pace === "TURN_IT_UP" || pace === "AFTER_DARK");
}

function extractLastUserText(messages) {
  const lastUser = Array.isArray(messages)
    ? [...messages].reverse().find((m) => m && m.role === "user" && typeof m.content === "string")
    : null;
  return String(lastUser?.content ?? "");
}

function summarizeRoles(messages) {
  if (!Array.isArray(messages)) return "not_array";
  const roles = messages.map((m) => (m && typeof m.role === "string" ? m.role : "bad_role"));
  const counts = roles.reduce((acc, r) => {
    acc[r] = (acc[r] || 0) + 1;
    return acc;
  }, {});
  return { total: messages.length, counts };
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

function signJwt(userId, adultVerified) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET not configured");
  return jwt.sign(
    { sub: userId, capability: adultVerified ? "after_dark" : "sfw", adult: adultVerified },
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
    req.userId = jwtPayload.sub;
    req.adultVerified = Boolean(jwtPayload.adult);
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

    const token = signJwt(user.id, user.adult_verified);

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
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ ok: false, error: "Username may only contain letters, numbers, and underscores." });
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

    const token = signJwt(user.id, user.adult_verified);

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

    const token = signJwt(user.id, user.adult_verified);

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

    // Determine founder eligibility
    let founder = false;
    if (invite.tier === "after_dark") {
      const countResult = await db.query(
        "SELECT COUNT(*) AS cnt FROM users WHERE founder = true"
      );
      const founderCount = parseInt(countResult.rows[0].cnt, 10);
      founder = founderCount < 20;
    }

    // Mark code as used
    await db.query(
      `UPDATE invite_codes
       SET used = true, used_by_device_id = $1, redeemed_at = NOW(), founder = $2
       WHERE id = $3`,
      [device_id, founder, invite.id]
    );

    // Best-effort: try to find a user associated with this device_id and set founder
    if (founder) {
      try {
        const userLookup = await db.query(
          "SELECT DISTINCT user_id FROM user_activity WHERE device_id = $1 AND user_id IS NOT NULL LIMIT 1",
          [device_id]
        );
        if (userLookup.rows.length > 0) {
          await db.query(
            "UPDATE users SET founder = true WHERE id = $1",
            [userLookup.rows[0].user_id]
          );
        }
      } catch (e) {
        console.warn("[REDEEM] Best-effort founder user update failed:", e?.message);
      }
    }

    return res.json({ ok: true, tier: invite.tier, founder });
  } catch (err) {
    console.error("REDEEM-CODE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Redemption failed." });
  }
});

app.post("/forgot-password", authLimiter, async (req, res) => {
  const genericResponse = { ok: true, message: "If that email is registered, a reset link has been sent." };

  try {
    const { email } = req.body || {};
    if (!email || !db) return res.json(genericResponse);

    const result = await db.query("SELECT id FROM users WHERE email = $1", [String(email).toLowerCase()]);
    if (result.rows.length === 0) return res.json(genericResponse);

    const userId = result.rows[0].id;
    const resetToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [userId, resetToken, expiresAt]
    );

    if (resend) {
      try {
        await resend.emails.send({
          from: EMAIL_FROM,
          to: email,
          subject: "Cal — Password Reset",
          text: `Reset your password: ${APP_URL}/reset-password?token=${resetToken}\n\nThis link expires in 1 hour.`,
          html: `<p>Reset your password:</p><p><a href="${APP_URL}/reset-password?token=${resetToken}">Click here</a></p><p>This link expires in 1 hour.</p>`,
        });
      } catch (emailErr) {
        console.warn("Failed to send reset email:", emailErr?.message || emailErr);
      }
    } else {
      console.warn("[FORGOT-PASSWORD] No RESEND_API_KEY configured. Reset token:", resetToken);
    }

    return res.json(genericResponse);
  } catch (err) {
    console.error("FORGOT-PASSWORD ERROR:", err);
    return res.json(genericResponse);
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
      return res.status(400).json({ ok: false, error: "Invalid or expired reset token." });
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

    return res.json({ ok: true, message: "Password reset successfully." });
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
  if (category === "recurring_theme") return "recurring_theme";
  return "preference";
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
            if (DEBUG_CHAT) {
              console.log(`[DETECT] Skipping identity stopword: "${value}"`);
            }
            continue;
          }
        }

        // Filter transient emotional states from emotional_moment captures
        if (category === "emotional_moment") {
          if (EMOTIONAL_STOPWORDS.some((word) => lowerValue === word || lowerValue.includes(word))) {
            if (DEBUG_CHAT) {
              console.log(`[DETECT] Skipping emotional stopword: "${value}"`);
            }
            continue;
          }
        }

        // Generate a key based on category and content
        const key = `${category}_${value.toLowerCase().replace(/\s+/g, "_").substring(0, 30)}`;

        detected.push({
          category,
          key,
          value: formatMemoryValue(category, value),
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
      return `He's into ${rawValue}`;
    case "dislikes":
      return `He can't stand ${rawValue}`;
    case "identity":
      return `He's ${rawValue}`;
    case "activities":
      return `He's ${rawValue}`;
    case "boundaries":
      return `Don't ${rawValue}`;
    case "emotional_moment":
      return `He shared that he's been ${rawValue}`;
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
// Chat Endpoint
// -----------------------------------
app.post("/chat", chatLimiter, requireAuth, async (req, res) => {
  try {
    const { messages = [], mode = "sfw", threadSummary = null, recentMessages = [], memories = [] } =
      req.body;
    const pace = paceFromReq(req.body);

    // Start weather fetch early (runs concurrently with DB queries)
    const weatherPromise = fetchChicagoWeather();

    const userText = extractLastUserText(messages);

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
      if (DEBUG_CHAT) {
        console.log("[CHAT DEBUG] blocked: no_user_text", {
          mode,
          pace,
          roles: summarizeRoles(messages),
        });
      }
      return res.status(400).json({
        ok: false,
        error: "No user message provided (messages empty or missing role:'user').",
      });
    }

    const taboo = violatesHardTaboo(userText);
    if (taboo) {
      if (DEBUG_CHAT) {
        console.log("[CHAT DEBUG] blocked: taboo", { mode, pace, taboo });
      }
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
    if (mode === "after_dark" && !isAdultVerifiedToken(req)) {
      if (DEBUG_CHAT) {
        console.log("[CHAT DEBUG] blocked: after_dark_not_verified", {
          hasToken: !!req.headers?.authorization,
          code: extractTokenCode(req),
        });
      }
      return res.json({
        ok: true,
        reply: "After Dark mode isn't available on your account. You can switch to SFW in Settings.",
        blocked: true,
        reason: "adult_verification_required",
      });
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
             WHERE (device_id = $1 OR user_id = $2) AND mode = $3
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

    const filteredMemories = buildMemoryContext(memories, mode, messages);
    const systemPrompt = buildSystemPrompt({ mode, pace, memories: filteredMemories, lastSessionSummary, realtimeContext });
    const patchApplied = isNsfwPatchApplied({ mode, pace });

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

    const model = "claude-sonnet-4-20250514";

    if (DEBUG_CHAT) {
      console.log("[CHAT DEBUG] request", {
        mode,
        pace,
        patchApplied,
        temperature,
        model,
        roles: summarizeRoles(messages),
        userTextLen: userText.length,
        systemPromptLen: systemPrompt.length,
        realtimeContext,
        weatherCached: !!weatherCache.data,
        hasSummary: !!threadSummary,
        recentMessagesCount: recentMessages.length,
        memoriesCount: memories.length,
      });
    }

    // Append thread summary to system prompt if available
    let fullSystemPrompt = systemPrompt;
    if (threadSummary) {
      fullSystemPrompt += `\n\nThread context: ${threadSummary}`;
    }

    // Build conversation history from messages
    let chatMessages = [];
    if (threadSummary && recentMessages.length > 0) {
      const olderMessages = messages.slice(0, -recentMessages.length);
      chatMessages = [
        ...olderMessages,
        ...recentMessages.map((m) => ({
          role: String(m.role || "").toLowerCase() === "assistant" ? "assistant" : "user",
          content: m.content,
        })),
      ];
    } else {
      chatMessages = [...messages];
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

    if (DEBUG_CHAT) {
      console.log(
        "[CHAT DEBUG] conversation roles",
        conversationHistory.map((m, i) => `${i}:${m.role}`)
      );
    }

    const calResponse = await sendMessageToCal({
      mode,
      systemPrompt: fullSystemPrompt,
      conversationHistory,
    });

    const rawReply = calResponse.reply ?? "(no reply)";
    const reply = softenEarlySnap(rawReply, messages).replace(/—/g, ",");

    if (DEBUG_CHAT) {
      console.log("[CHAT DEBUG] reply", {
        replyLen: reply.length,
        startsWith: reply.slice(0, 80),
      });
    }

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
           WHERE (device_id = $1 OR user_id = $2)
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
          const recurring = chatDeviceId ? trackRecurringThemes(chatDeviceId, userText) : [];
          const allDetected = [...detected, ...recurring];

          for (const mem of allDetected) {
            const effectiveDeviceId = chatDeviceId || `user_${chatUserId}`;
            await db.query(
              `INSERT INTO memories (device_id, key, value, mode, confidence, type, user_id)
               VALUES ($1, $2, $3, $4, 'high', $5, $6)
               ON CONFLICT (device_id, key)
               DO UPDATE SET value = $3, mode = $4, type = COALESCE($5, memories.type),
                            user_id = COALESCE($6, memories.user_id), updated_at = NOW()`,
              [effectiveDeviceId, mem.key, mem.value, mode, mem.type || typeFromCategory(mem.category), chatUserId]
            );
          }
          if (DEBUG_CHAT && allDetected.length > 0) {
            console.log(`[AUTO-DETECT] Saved ${allDetected.length} memories for ${chatDeviceId || chatUserId}`);
          }
        } catch (e) {
          console.warn("[AUTO-DETECT] Failed:", e?.message || e);
        }
      })();
    }

    return res.json({ ok: true, reply, easterEgg: null });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    return res.status(500).json({ ok: false, error: "Chat failed" });
  }
});
// -----------------------------------
// Summarize Endpoint
// -----------------------------------
app.post("/summarize", chatLimiter, requireAuth, async (req, res) => {
  try {
    const { messages = [], mode = "sfw" } = req.body;

    if (mode === "after_dark" && !isAdultVerifiedToken(req)) {
      return res.json({
        ok: true,
        blocked: true,
        reason: "adult_verification_required",
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Messages array required for summarization",
      });
    }

    if (DEBUG_CHAT) {
      console.log("[SUMMARIZE DEBUG] request", {
        messageCount: messages.length,
        mode,
      });
    }

    const conversationText = messages
      .map((m) => {
        const speaker = m.role === "user" ? "User" : "Cal";
        return `${speaker}: ${m.content}`;
      })
      .join("\n\n");

    const modeNote =
      mode === "after_dark"
        ? "This is an After Dark conversation. Summarize content accurately including mature themes."
        : "This is an SFW conversation. Keep the summary appropriate and non-explicit.";

    const systemPrompt = `You are summarizing a conversation between the user and Cal (an AI companion).

Create a concise 2-3 sentence summary that captures:
- Main topics discussed
- User's current emotional state or context
- Key preferences or facts mentioned

Keep it brief and factual. This will be used as context for future messages. ${modeNote}`;

    const userPrompt = `Summarize this conversation:\n\n${conversationText}`;

    const completion = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.3,
      max_tokens: 150,
    });

    const summary = completion?.content?.[0]?.text ?? "";

    if (DEBUG_CHAT) {
      console.log("[SUMMARIZE DEBUG] summary generated", {
        summaryLength: summary.length,
      });
    }

    return res.json({ ok: true, summary });
  } catch (err) {
    console.error("SUMMARIZE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Summarization failed" });
  }
});

// -----------------------------------
// Session Summary Endpoints
// -----------------------------------

// POST /session-summary — generate and store a session continuity summary
app.post("/session-summary", requireAuth, async (req, res) => {
  try {
    const { messages = [], mode = "sfw", device_id } = req.body;
    const userId = req.userId || null;
    const deviceId = device_id || null;

    if (mode === "after_dark" && !isAdultVerifiedToken(req)) {
      return res.json({
        ok: true,
        blocked: true,
        reason: "adult_verification_required",
      });
    }

    if (!deviceId && !userId) {
      return res.status(400).json({ ok: false, error: "device_id required" });
    }

    if (!messages.length) {
      return res.status(400).json({ ok: false, error: "messages required" });
    }

    const conversationText = messages
      .map((m) => {
        const speaker = m.role === "user" ? "User" : "Cal";
        return `${speaker}: ${m.content}`;
      })
      .join("\n\n");

    const completion = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      system: SESSION_SUMMARY_PROMPT,
      messages: [{ role: "user", content: conversationText }],
      temperature: 0.3,
      max_tokens: 200,
    });

    const summary = completion?.content?.[0]?.text?.trim() || "";

    // Store in DB (best-effort)
    if (db && summary) {
      try {
        await db.query(
          `INSERT INTO session_summaries (device_id, user_id, mode, summary)
           VALUES ($1, $2, $3, $4)`,
          [deviceId, userId, mode, summary]
        );
      } catch (e) {
        console.warn("[SESSION] Summary store failed:", e?.message);
      }
    }

    return res.json({ ok: true, summary });
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
      // JWT auth with device_id: get both transferred and untransferred memories
      whereClause = "(device_id = $1 OR user_id = $2)";
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

    query += " ORDER BY created_at DESC";

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
      [device_id, key, value, mode, type, userId]
    );

    return res.json({
      ok: true,
      memory: result.rows[0],
    });
  } catch (err) {
    console.error("POST /memories error:", err);
    return res.status(500).json({ ok: false, error: "Failed to create memory" });
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
    const { value, mode } = req.body;

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
       SET value = $1, mode = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [value, mode || null, id]
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
    if (DEBUG_CHAT) {
      console.log("[DETECT] Skipping: Average message length too short (rapid-fire)");
    }
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
    if (DEBUG_CHAT) {
      console.log("[DETECT] Skipping: High escalation detected");
    }
    return false;
  }

  if (DEBUG_CHAT) {
    console.log("[DETECT] Skipping: No high-value patterns in recent messages");
  }

  return false;
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
      if (DEBUG_CHAT) {
        console.log("[DETECT DEBUG] Detection skipped based on context");
      }
      return res.json({
        ok: true,
        detected: [],
        count: 0,
        skipped: true,
      });
    }

    if (DEBUG_CHAT) {
      console.log("[DETECT DEBUG] Analyzing", messages.length, "messages for memories");
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

    if (DEBUG_CHAT) {
      console.log("[DETECT DEBUG] Recent user messages:", recentUserMessages);
      console.log("[DETECT DEBUG] Correction detected:", containsCorrection(combinedRecentText));
      console.log("[DETECT DEBUG] Detection input:", userMessages);
    }

    // Use heuristic detection on narrowed input
    const detected = detectMemoriesHeuristic(userMessages);

    if (DEBUG_CHAT) {
      console.log("[DETECT DEBUG] Found", detected.length, "potential memories");
    }

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
       WHERE (device_id = $1 OR user_id = $2)
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
       WHERE (device_id = $1 OR user_id = $2) AND mode = $3
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
       WHERE (device_id = $1 OR user_id = $2)
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
    model: "claude-sonnet-4-20250514",
    system: systemPrompt,
    messages: [{ role: "user", content: "[System: generate a re-engagement message for this user]" }],
    temperature: 0.85,
    max_tokens: 150,
  });

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
// Start Server (Railway expects process.env.PORT)
// -----------------------------------
const resolvedPort = Number(process.env.PORT);
const PORT = Number.isFinite(resolvedPort) ? resolvedPort : 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 Cal server listening on 0.0.0.0:${PORT}`);
});

// Keepalive log (helps confirm it isn't being killed)
if (DEBUG_CHAT) {
  setInterval(() => {
    console.log("💚 still alive", { port: PORT, portEnv: process.env.PORT ?? null, ts: Date.now() });
  }, 30000);
}