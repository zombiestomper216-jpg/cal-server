// cal-server/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import pg from "pg";

import {
  BROMO_SFW_SYSTEM_PROMPT_V2,
  BROMO_NSFW_SYSTEM_PROMPT_V2,
  NSFW_BEHAVIOR_PATCH,
} from "./prompts.js";

dotenv.config();

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

// Toggle verbose debug without code changes (set on Railway)
const DEBUG_CHAT = String(process.env.DEBUG_CHAT || "").toLowerCase() === "true";

// Log env presence (safe – does NOT print secrets)
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

function buildSystemPrompt({ mode, pace, memories = [] }) {
  let basePrompt = "";

  if (mode === "NSFW") {
    if (pace === "TURN_IT_UP" || pace === "AFTER_DARK") {
      basePrompt = `${BROMO_NSFW_SYSTEM_PROMPT_V2}\n\n${NSFW_BEHAVIOR_PATCH}`;
    } else {
      basePrompt = BROMO_NSFW_SYSTEM_PROMPT_V2;
    }
  } else {
basePrompt = BROMO_SFW_SYSTEM_PROMPT_V2;  }

  // PHASE 4: Natural memory injection (limit to 50 max, prioritize recent)
  if (memories && memories.length > 0) {
    // Limit to 50 memories max
    const limitedMemories = memories.slice(0, 50);

    // Convert to natural, relational language
    const memoryLines = limitedMemories
      .map((m) => {
        let value = m.value;

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
      .join("\n");

    // PHASE 4: Natural header instead of "REMEMBERED FACTS"
    basePrompt += `\n\nThings you've learned about him over time:\n${memoryLines}`;
  }

  return basePrompt;
}

// PHASE 4: Modular memory context builder (prep for Phase 5 semantic search)
function buildMemoryContext(allMemories, mode) {
  if (!allMemories || allMemories.length === 0) return [];

  // Filter by mode
  const filtered = allMemories.filter((m) => !m.mode || m.mode === mode || m.mode === null);

  // PHASE 4: Prioritize high confidence, then by recency
  const sorted = filtered.sort((a, b) => {
    // High confidence first
    if (a.confidence === "high" && b.confidence !== "high") return -1;
    if (b.confidence === "high" && a.confidence !== "high") return 1;

    // Then by updated_at (most recent first)
    return new Date(b.updated_at) - new Date(a.updated_at);
  });

  // Hard limit: 50 memories max
  return sorted.slice(0, 50);
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

// Minimal post-gen guard to prevent curt default opener on early turns
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
  // NOTE: This is a lightweight session token for the beta.
  // There is currently no auth middleware enforcing it server-side.
  return `${prefix}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
}

app.post("/auth", (req, res) => {
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

  // Legacy path: username/password (optional)
  const { username, password } = body;

  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      error: "Missing credentials (provide tester code or username/password).",
    });
  }

  const devUser = process.env.DEV_AUTH_USER || process.env.AUTH_USER || "";
  const devPass = process.env.DEV_AUTH_PASS || process.env.AUTH_PASS || "";

  if (devUser && devPass) {
    if (String(username).trim() !== devUser || String(password) !== devPass) {
      return res.status(401).json({ ok: false, error: "Invalid credentials." });
    }
  } else {
    // If no dev creds are configured, keep the old permissive behavior for local dev
    if (DEBUG_CHAT) console.log("[AUTH] No DEV_AUTH_USER/DEV_AUTH_PASS set; allowing legacy login.");
  }

  return res.json({
    ok: true,
    token: makeSessionToken("dev"),
    adultVerified: true,
  });
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

        // PHASE 4: For identity category, check stopwords
        if (category === "identity") {
          const lowerValue = value.toLowerCase();
          if (IDENTITY_STOPWORDS.some((word) => lowerValue === word || lowerValue.includes(word))) {
            if (DEBUG_CHAT) {
              console.log(`[DETECT] Skipping identity stopword: "${value}"`);
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
          confidence: "low", // User-confirmed memories upgrade to 'high'
          matchedPattern: pattern.source,
        });
      }
    }
  }

  return detected;
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
    default:
      return rawValue;
  }
}

// -----------------------------------
// Chat Endpoint
// -----------------------------------
app.post("/chat", async (req, res) => {
  try {
    const { messages = [], mode = "SFW", threadSummary = null, recentMessages = [], memories = [] } =
      req.body;
    const pace = paceFromReq(req.body);

    const userText = extractLastUserText(messages);

    // Never call OpenAI without a real user message.
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

    const systemPrompt = buildSystemPrompt({ mode, pace, memories });
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
        hasSummary: !!threadSummary,
        recentMessagesCount: recentMessages.length,
        memoriesCount: memories.length,
      });
    }

    // Build context with thread summary if available
    let contextMessages = [];

    if (threadSummary) {
      // Use summary + recent messages instead of full history
      contextMessages = [
        { role: "system", content: systemPrompt },
        { role: "system", content: `Thread context: ${threadSummary}` },
        ...recentMessages.map((m) => ({ role: m.role, content: m.content })),
        ...messages,
      ];
    } else {
      // Fallback to original behavior
      contextMessages = [{ role: "system", content: systemPrompt }, ...messages];
    }

    const completion = await openai.chat.completions.create({
      model,
      messages: contextMessages,
      temperature,
    });

    const rawReply = completion?.choices?.[0]?.message?.content ?? "(no reply)";
    const reply = softenEarlySnap(rawReply, messages);

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
// Summarize Endpoint
// -----------------------------------
app.post("/summarize", async (req, res) => {
  try {
    const { messages = [], mode = "SFW" } = req.body;

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

    // Build conversation text
    const conversationText = messages
      .map((m) => {
        const speaker = m.role === "user" ? "User" : "Bromo";
        return `${speaker}: ${m.content}`;
      })
      .join("\n\n");

    // Summarization prompt
    const systemPrompt = `You are summarizing a conversation between the user and Bromo (an AI companion).

Create a concise 2-3 sentence summary that captures:
- Main topics discussed
- User's current emotional state or context
- Key preferences or facts mentioned

Keep it brief and factual. This will be used as context for future messages.`;

    const userPrompt = `Summarize this conversation:\n\n${conversationText}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 150,
    });

    const summary = completion?.choices?.[0]?.message?.content ?? "";

    if (DEBUG_CHAT) {
      console.log("[SUMMARIZE DEBUG] summary generated", {
        summaryLength: summary.length,
        tokensUsed: completion?.usage?.total_tokens || 0,
      });
    }

    return res.json({ ok: true, summary });
  } catch (err) {
    console.error("SUMMARIZE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Summarization failed" });
  }
});

// -----------------------------------
// Memory Endpoints (Phase 2)
// -----------------------------------

// GET /memories - List all memories for a device
app.get("/memories", async (req, res) => {
  try {
    const { device_id, mode } = req.query;

    if (!device_id) {
      return res.status(400).json({
        ok: false,
        error: "device_id required",
      });
    }

    let query = "SELECT * FROM memories WHERE device_id = $1 AND confidence = 'high'";
    const params = [device_id];

    // Filter by mode if specified
    if (mode) {
      query += " AND (mode = $2 OR mode IS NULL)";
      params.push(mode);
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
app.post("/memories", async (req, res) => {
  try {
    const { device_id, key, value, mode = null } = req.body;

    if (!device_id || !key || !value) {
      return res.status(400).json({
        ok: false,
        error: "device_id, key, and value required",
      });
    }

    const result = await db.query(
      `INSERT INTO memories (device_id, key, value, mode, confidence)
       VALUES ($1, $2, $3, $4, 'high')
       ON CONFLICT (device_id, key)
       DO UPDATE SET value = $3, mode = $4, updated_at = NOW()
       RETURNING *`,
      [device_id, key, value, mode]
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

// PUT /memories/:id - Update a memory
app.put("/memories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { value, mode } = req.body;

    if (!value) {
      return res.status(400).json({
        ok: false,
        error: "value required",
      });
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
app.delete("/memories/:id", async (req, res) => {
  try {
    const { id } = req.params;

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
    .filter((m) => m.role === "user")
    .slice(-5)
    .map((m) => m.content);

  if (recentUserMessages.length === 0) return false;

  // PHASE 4: Skip detection during rapid-fire short replies
  const avgLength =
    recentUserMessages.reduce((sum, msg) => sum + msg.split(" ").length, 0) /
    recentUserMessages.length;
  if (avgLength < 5) {
    if (DEBUG_CHAT) {
      console.log("[DETECT] Skipping: Average message length too short (rapid-fire)");
    }
    return false;
  }

  // PHASE 4: Skip during high escalation NSFW sequences
  const lastMessage = recentUserMessages[recentUserMessages.length - 1].toLowerCase();
  const nsfwEscalationKeywords = [
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
  const hasMultipleNsfwKeywords =
    nsfwEscalationKeywords.filter((kw) => lastMessage.includes(kw)).length >= 2;

  if (hasMultipleNsfwKeywords) {
    if (DEBUG_CHAT) {
      console.log("[DETECT] Skipping: High NSFW escalation detected");
    }
    return false;
  }

  // PHASE 4: Only trigger if high-value patterns likely present
  const hasIdentityLanguage = /\b(?:my name is|call me|i'm a|i work as)\b/i.test(lastMessage);
  const hasBoundaryLanguage = /\b(?:never|don't ever|don't mention|boundaries?)\b/i.test(lastMessage);
  const hasPreferenceLanguage = /\b(?:i love|i like|i enjoy|i prefer|i'm into|i hate|i dislike)\b/i.test(
    lastMessage
  );

  const hasHighValuePattern = hasIdentityLanguage || hasBoundaryLanguage || hasPreferenceLanguage;

  if (!hasHighValuePattern) {
    if (DEBUG_CHAT) {
      console.log("[DETECT] Skipping: No high-value patterns detected");
    }
    return false;
  }

  return true;
}

// POST /detect-memory - Analyze recent messages for memorable facts
app.post("/detect-memory", async (req, res) => {
  try {
    const { messages = [], mode = "SFW" } = req.body;

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

    // Combine recent user messages for analysis
    const userMessages = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ");

    // Use heuristic detection
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
// Start Server (Railway expects process.env.PORT)
// -----------------------------------
const resolvedPort = Number(process.env.PORT);
const PORT = Number.isFinite(resolvedPort) ? resolvedPort : 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 Bromo server listening on 0.0.0.0:${PORT}`);
});

// Keepalive log (helps confirm it isn't being killed)
setInterval(() => {
  console.log("💚 still alive", { port: PORT, portEnv: process.env.PORT ?? null, ts: Date.now() });
}, 30000);