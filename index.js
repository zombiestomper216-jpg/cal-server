// cal-server/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import pg from "pg";

import {
  BROMO_SFW_SYSTEM_PROMPT_V1,
  BROMO_NSFW_SYSTEM_PROMPT_V1,
  NSFW_BEHAVIOR_PATCH,
} from "./prompts.js";

dotenv.config();

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------------
// Postgres
// -----------------------------------
const DATABASE_URL = process.env.DATABASE_URL || "";

// If your server does NOT support SSL, forcing ssl will break.
// So we only enable SSL if you explicitly ask for it in the URL.
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
// Root (helps hosts / uptime checks)
// -----------------------------------
app.get("/", (_req, res) => {
  res.send("Bromo API is running");
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
function paceFromReq(reqBody) {
  const drift = String(reqBody?.prefs?.driftSpeed ?? reqBody?.pace ?? "NORMAL").toUpperCase();
  if (drift === "AFTER_DARK") return "AFTER_DARK";
  if (drift === "FAST") return "TURN_IT_UP";
  if (drift === "SLOW") return "SLOW_BURN";
  return "NORMAL";
}

function buildSystemPrompt({ mode, pace }) {
  if (mode === "NSFW") {
    if (pace === "TURN_IT_UP" || pace === "AFTER_DARK") {
      return `${BROMO_NSFW_SYSTEM_PROMPT_V1}\n\n${NSFW_BEHAVIOR_PATCH}`;
    }
    return BROMO_NSFW_SYSTEM_PROMPT_V1;
  }
  return BROMO_SFW_SYSTEM_PROMPT_V1;
}

function extractLastUserText(messages) {
  const lastUser = Array.isArray(messages)
    ? [...messages].reverse().find((m) => m && m.role === "user" && typeof m.content === "string")
    : null;
  return String(lastUser?.content ?? "");
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
    /\bteen\b/i,
    /\bchild\b/i,
    /\bkid\b/i,
    /\blittle girl\b/i,
    /\blittle boy\b/i,
    /\bschoolgirl\b/i,
    /\bschoolboy\b/i,
  ];

  const nonConPatterns = [
    /\bno means yes\b/i,
    /\bignore (my|the) no\b/i,
    /\b(force|forced)\b/i,
  ];

  if (incestPatterns.some((r) => r.test(t))) return "incest_stepfamily";
  if (minorPatterns.some((r) => r.test(t))) return "minors";
  if (nonConPatterns.some((r) => r.test(t))) return "nonconsent";
  return null;
}

// -----------------------------------
// Auth (temporary / dev)
// -----------------------------------
app.post("/auth", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      error: "Missing credentials",
    });
  }

  return res.json({
    ok: true,
    token: "dev-token",
    adultVerified: true,
  });
});

// -----------------------------------
// Chat Endpoint
// -----------------------------------
app.post("/chat", async (req, res) => {
  try {
    const { messages = [], mode = "SFW" } = req.body;
    const pace = paceFromReq(req.body);

    const userText = extractLastUserText(messages);
    const taboo = violatesHardTaboo(userText);

    if (taboo) {
      return res.json({
        ok: true,
        reply: "That’s not something I do. Let’s switch gears.",
        blocked: true,
        reason: taboo,
      });
    }

    const systemPrompt = buildSystemPrompt({ mode, pace });

    const temperature =
      mode === "NSFW"
        ? pace === "AFTER_DARK"
          ? 0.95
          : pace === "TURN_IT_UP"
            ? 0.9
            : 0.85
        : 0.7;

    const model = "gpt-4o-mini";

    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature,
    });

    const reply = completion?.choices?.[0]?.message?.content ?? "(no reply)";

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

    return res.json({ ok: true, reply });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    return res.status(500).json({ ok: false, error: "Chat failed" });
  }
});

// -----------------------------------
// Start Server (Railway-compatible)
// -----------------------------------
const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 Bromo server running on port ${PORT}`);
});

