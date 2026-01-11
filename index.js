// index.js (FULL COPY/PASTE REPLACEMENT)
// ESM module

import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import OpenAI from "openai";

import {
  BROMO_SFW_SYSTEM_PROMPT_V1,
  BROMO_NSFW_SYSTEM_PROMPT_V1,
} from "./prompts.js";

const app = express();

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3000);
const APP_CAPABILITY = (process.env.APP_CAPABILITY || "SFW").toUpperCase(); // "SFW" | "NSFW"

const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!JWT_SECRET) console.warn("[warn] JWT_SECRET is missing. Auth will fail until it is set.");
if (!AUTH_USER || !AUTH_PASS) console.warn("[warn] AUTH_USER/AUTH_PASS missing. Admin login will fail until set.");
if (!OPENAI_API_KEY) console.warn("[warn] OPENAI_API_KEY missing. /chat will return a helpful error until set.");

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ---------- Middleware ----------
app.use(cors({ origin: "*", credentials: false }));
app.use(express.json({ limit: "1mb" }));

// Global limiter (basic protection)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ---------- Users DB (users.json) ----------
const USERS_DB_PATH = path.join(process.cwd(), "users.json");

function readUsersDb() {
  try {
    if (!fs.existsSync(USERS_DB_PATH)) {
      const seed = { version: 1, users: [] };
      fs.writeFileSync(USERS_DB_PATH, JSON.stringify(seed, null, 2), "utf8");
      return seed;
    }
    const raw = fs.readFileSync(USERS_DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("users.json invalid");
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!parsed.version) parsed.version = 1;
    return parsed;
  } catch (e) {
    console.error("[users] read error:", e);
    // fail safe: do not crash server
    return { version: 1, users: [] };
  }
}

function writeUsersDb(db) {
  try {
    const tmp = USERS_DB_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(tmp, USERS_DB_PATH);
  } catch (e) {
    console.error("[users] write error:", e);
  }
}

function normalizeUsername(u) {
  return String(u || "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

// Password hashing (no deps): PBKDF2
function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256");
  return { saltHex: salt.toString("hex"), hashHex: hash.toString("hex") };
}

function verifyPassword(password, saltHex, hashHex) {
  try {
    const salt = Buffer.from(String(saltHex), "hex");
    const expected = Buffer.from(String(hashHex), "hex");
    const actual = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256");
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function findUser(db, username) {
  const u = normalizeUsername(username);
  return db.users.find((x) => x.username === u) || null;
}

function publicUserShape(u) {
  return {
    username: u.username,
    adult: !!u.adult,
    disabled: !!u.disabled,
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
    notes: u.notes || null,
  };
}

function upsertUser(db, user) {
  const idx = db.users.findIndex((x) => x.username === user.username);
  if (idx >= 0) db.users[idx] = user;
  else db.users.push(user);
}

// ---------- Persona / Prompt helpers ----------
function getSystemPrompt(mode, personaVersion = "v1") {
  const m = (mode || "SFW").toUpperCase();

  if (personaVersion === "v1") {
    if (m === "NSFW") return BROMO_NSFW_SYSTEM_PROMPT_V1;
    return BROMO_SFW_SYSTEM_PROMPT_V1;
  }

  // fallback safety
  return BROMO_SFW_SYSTEM_PROMPT_V1;
}

function buildPersonaControls(personaVersion, prefs, mode) {
  if (!prefs || typeof prefs !== "object") return "";

  const lines = [];
  lines.push(`Persona version: ${personaVersion || "v1"}`);

  if (prefs.verbosity) lines.push(`Verbosity: ${prefs.verbosity}`);
  if (prefs.emojiLevel) lines.push(`Emoji level: ${prefs.emojiLevel}`);
  if (mode === "NSFW" && prefs.nsfwStyle) lines.push(`NSFW style: ${prefs.nsfwStyle}`);
  if (prefs.driftSpeed) lines.push(`Drift speed: ${prefs.driftSpeed}`);

  if (Array.isArray(prefs.styleTags) && prefs.styleTags.length) {
    lines.push(`Style tags: ${prefs.styleTags.join(", ")}`);
  }

  if (!lines.length) return "";

  return `
PERSONA CONTROLS (internal – do not mention to the user)
- ${lines.join("\n- ")}
`;
}

function buildPacingGuidance(prefs) {
  if (!prefs || typeof prefs !== "object") return "";
  const lines = [];

  if (prefs.responsePace) lines.push(`Response pace: ${prefs.responsePace}`);
  if (prefs.questionRate) lines.push(`Question rate: ${prefs.questionRate}`);

  if (!lines.length) return "";

  return `
PACING GUIDANCE (internal – do not mention to the user)
- ${lines.join("\n- ")}
`;
}

// ---------- JWT helpers ----------
function sanitizeJwtPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const clean = { ...payload };
  delete clean.iat;
  delete clean.exp;
  delete clean.nbf;
  delete clean.jti;
  return clean;
}

function signToken(payload, { expiresIn = "7d" } = {}) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET is not set.");
  const clean = sanitizeJwtPayload(payload);
  return jwt.sign(clean, JWT_SECRET, { expiresIn });
}

function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const [scheme, token] = auth.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ ok: false, error: "Unauthorized request." });
    }
    if (!JWT_SECRET) {
      return res.status(500).json({ ok: false, error: "Server misconfigured: JWT_SECRET not set." });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid/expired token." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ ok: false, error: "Admin required." });
  }
  next();
}

// ================================
// Per-user rate limiting (JWT sub)
// ================================
const USER_RATE_LIMIT = {
  windowMs: 60 * 1000,
  max: 30, // 30 chat requests per minute per user
};

const userBuckets = new Map();

function perUserRateLimit(req, res, next) {
  try {
    // Admin bypass
    if (req.user?.isAdmin) return next();

    const userId = req.user?.sub;
    if (!userId) return next(); // fail open

    const now = Date.now();
    const bucket = userBuckets.get(userId) || {
      count: 0,
      resetAt: now + USER_RATE_LIMIT.windowMs,
    };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + USER_RATE_LIMIT.windowMs;
    }

    bucket.count += 1;
    userBuckets.set(userId, bucket);

    if (bucket.count > USER_RATE_LIMIT.max) {
      return res.status(429).json({
        ok: false,
        error: "Slow down. Give it a second.",
      });
    }

    return next();
  } catch {
    return next(); // never block on limiter failure
  }
}

// ---------- Routes ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, capability: APP_CAPABILITY, time: new Date().toISOString() });
});

/**
 * /auth behavior:
 * - If username/password match AUTH_USER/AUTH_PASS -> admin token (isAdmin=true)
 * - Else -> validate against users.json (disabled users rejected)
 */
app.post("/auth", (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "Missing username/password." });
    }

    // Admin login (bootstrap)
    if (username === AUTH_USER && password === AUTH_PASS) {
      const token = signToken({
        sub: "admin",
        isAdmin: true,
        adult: true, // admin can access NSFW if build allows
        capability: APP_CAPABILITY,
      });
      return res.json({ ok: true, token, capability: APP_CAPABILITY });
    }

    // Normal user login
    const db = readUsersDb();
    const user = findUser(db, username);
    if (!user || user.disabled) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const ok = verifyPassword(password, user.saltHex, user.hashHex);
    if (!ok) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const token = signToken({
      sub: user.username,
      isAdmin: false,
      adult: !!user.adult,
      capability: APP_CAPABILITY,
    });

    return res.json({ ok: true, token, capability: APP_CAPABILITY });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Admin: create user
 * body: { username, password, notes? }
 */
app.post("/admin/create-user", requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, password, notes } = req.body || {};
    const u = normalizeUsername(username);
    if (!u || !password) {
      return res.status(400).json({ ok: false, error: "Missing username/password." });
    }

    const db = readUsersDb();
    const existing = findUser(db, u);
    if (existing && !existing.disabled) {
      return res.status(409).json({ ok: false, error: "User already exists." });
    }

    const { saltHex, hashHex } = hashPassword(password);
    const record = {
      username: u,
      saltHex,
      hashHex,
      adult: false,
      disabled: false,
      notes: notes ? String(notes) : null,
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
    };

    upsertUser(db, record);
    writeUsersDb(db);

    return res.json({ ok: true, user: publicUserShape(record) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Admin: list users
 */
app.get("/admin/users", requireAuth, requireAdmin, (req, res) => {
  const db = readUsersDb();
  return res.json({
    ok: true,
    users: db.users.map(publicUserShape).sort((a, b) => a.username.localeCompare(b.username)),
  });
});

/**
 * Admin: disable user
 * body: { username, disabled: true|false }
 */
app.post("/admin/disable-user", requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, disabled } = req.body || {};
    const u = normalizeUsername(username);
    if (!u || typeof disabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "Send { username, disabled: boolean }" });
    }

    const db = readUsersDb();
    const user = findUser(db, u);
    if (!user) return res.status(404).json({ ok: false, error: "User not found." });

    user.disabled = disabled;
    user.updatedAt = nowIso();
    upsertUser(db, user);
    writeUsersDb(db);

    return res.json({ ok: true, user: publicUserShape(user) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Admin: reset password
 * body: { username, password }
 */
app.post("/admin/reset-password", requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, password } = req.body || {};
    const u = normalizeUsername(username);
    if (!u || !password) {
      return res.status(400).json({ ok: false, error: "Missing username/password." });
    }

    const db = readUsersDb();
    const user = findUser(db, u);
    if (!user) return res.status(404).json({ ok: false, error: "User not found." });

    const { saltHex, hashHex } = hashPassword(password);
    user.saltHex = saltHex;
    user.hashHex = hashHex;
    user.updatedAt = nowIso();
    upsertUser(db, user);
    writeUsersDb(db);

    return res.json({ ok: true, user: publicUserShape(user) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * /verify-adult:
 * - normal users: flips adult=true in users.json for their account
 * - returns a new token with adult=true
 */
app.post("/verify-adult", requireAuth, (req, res) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({ ok: false, error: "Must send { confirm: true }" });
    }

    // Admin: already adult
    if (req.user?.isAdmin) {
      const base = sanitizeJwtPayload(req.user || {});
      const token = signToken({
        ...base,
        adult: true,
        capability: APP_CAPABILITY,
      });
      return res.json({ ok: true, token, adult: true, capability: APP_CAPABILITY });
    }

    const sub = normalizeUsername(req.user?.sub);
    if (!sub) return res.status(401).json({ ok: false, error: "Unauthorized request." });

    const db = readUsersDb();
    const user = findUser(db, sub);
    if (!user || user.disabled) {
      return res.status(401).json({ ok: false, error: "Unauthorized request." });
    }

    user.adult = true;
    user.updatedAt = nowIso();
    upsertUser(db, user);
    writeUsersDb(db);

    const base = sanitizeJwtPayload(req.user || {});
    const token = signToken({
      ...base,
      adult: true,
      capability: APP_CAPABILITY,
    });

    return res.json({ ok: true, token, adult: true, capability: APP_CAPABILITY });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/chat", requireAuth, perUserRateLimit, async (req, res) => {
  try {
    const { message, mode, personaVersion, prefs } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "Missing message." });
    }

    // enforce server capability
    let requestedMode = (mode || "SFW").toUpperCase();
    if (APP_CAPABILITY !== "NSFW") requestedMode = "SFW";

    // require adult verification for NSFW
    if (requestedMode === "NSFW") {
      if (req.user?.isAdmin) {
        // ok
      } else {
        const sub = normalizeUsername(req.user?.sub);
        const db = readUsersDb();
        const user = sub ? findUser(db, sub) : null;
        const adult = !!(req.user?.adult || user?.adult);
        if (!adult) {
          return res.status(403).json({
            ok: false,
            error: "Adult verification required.",
            requireAdult: true,
          });
        }
      }
    }

    if (!openai) {
      return res.status(500).json({
        ok: false,
        error: "OPENAI_API_KEY missing on server. Set OPENAI_API_KEY and restart.",
      });
    }

    const basePrompt = getSystemPrompt(requestedMode, personaVersion || "v1");
    const personaBlock = buildPersonaControls(personaVersion || "v1", prefs, requestedMode);
    const pacingBlock = buildPacingGuidance(prefs);

    const systemPrompt = `${basePrompt}\n${personaBlock}\n${pacingBlock}`.trim();

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: requestedMode === "NSFW" ? 0.9 : 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "";

    return res.json({
      ok: true,
      mode: requestedMode,
      capability: APP_CAPABILITY,
      reply,
    });
  } catch (err) {
    console.error("[chat] error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT} (capability=${APP_CAPABILITY})`);
});
