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

// Toggle verbose debug without code changes (set on Railway)
const DEBUG_CHAT = String(process.env.DEBUG_CHAT || "").toLowerCase() === "true";

// Log env presence (safe — does NOT print secrets)
console.log("BOOT env check:", {
  hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
  hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
  portEnv: process.env.PORT ?? null,
  debugChat: DEBUG_CHAT,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------------
// Postgres
// -----------------------------------
const DATABASE_URL = process.env.DATABASE_URL || "";

// Only enable SSL if explicitly requested in DATABASE_URL.
// (Your VPS Postgres does NOT support SSL)
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
// Root
// -----------------------------------
app.get("/", (_req, res) => {
  res.status(200).send("Bromo API is running");
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

function isNsfwPatchApplied({ mode, pace }) {
  return mode === "NSFW" && (pace === "TURN_IT_UP" || pace === "AFTER_DARK");
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

function violatesHardTaboo(userTextRaw) {
  const t = String(userTextRaw || "").toLowerCase();

  const incestPatterns = [
    /\bstep[-\s]?(brother|sister|dad|mom|father|mother|son|daughter)\b/i,
    /\b(stepbro|stepsis)\b/i,
    /\bincest\b/i,
  ];

function softenEarlySnap(reply, messages) {
  if (!Array.isArray(messages) || messages.length <= 1) {
    const r = String(reply || "").trim().toLowerCase();
    if (r === "what do you want?" || r === "focus. what do you want?") {
      return "Yeah. I’m here.";
    }
  }
  return reply;
}


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

    // ✅ Minimal guard: never call OpenAI without a real user message.
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
        reply: "That’s not something I do. Let’s switch gears.",
        blocked: true,
        reason: taboo,
      });
    }

    const systemPrompt = buildSystemPrompt({ mode, pace });
    const patchApplied = isNsfwPatchApplied({ mode, pace });

    const temperature =
      mode === "NSFW"
        ? pace === "AFTER_DARK"
          ? 0.95
          : pace === "TURN_IT_UP"
            ? 0.9
            : 0.85
        : 0.7;

    const model = "gpt-4o-mini";

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
      });
    }

    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature,
    });

    const rawReply = completion?.choices?.[0]?.message?.content ?? "(no reply)";
const reply = softenEarlySnap(rawReply, messages);
return res.json({ ok: true, reply });


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

    return res.json({ ok: true, reply });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    return res.status(500).json({ ok: false, error: "Chat failed" });
  }
});

// -----------------------------------
// Start Server (Railway expects process.env.PORT)
// -----------------------------------
const resolvedPort = Number(process.env.PORT);
const PORT = Number.isFinite(resolvedPort) ? resolvedPort : 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 Bromo server listening on 0.0.0.0:${PORT}`);
});

// Keepalive log (helps confirm it isn't being killed)
setInterval(() => {
  console.log("💓 still alive", { port: PORT, portEnv: process.env.PORT ?? null, ts: Date.now() });
}, 30000);
