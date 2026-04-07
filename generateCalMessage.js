import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const db = new Pool({ connectionString: process.env.DATABASE_URL });

export async function generateCalMessage(user) {
  // Load system prompt based on mode (default SFW)
  const promptFile =
    user.mode === "after_dark"
      ? "cal_after_dark_system.txt"
      : "cal_sfw_system.txt";
  const systemPrompt = readFileSync(
    join(__dirname, "prompts", promptFile),
    "utf8"
  );

  // Query 5 most recent memories via device_id
  let memories = [];
  if (user.device_id) {
    try {
      const result = await db.query(
        "SELECT key, value FROM memories WHERE device_id = $1 ORDER BY created_at DESC LIMIT 5",
        [user.device_id]
      );
      memories = result.rows;
    } catch (e) {
      console.warn("[NOTIF] Memory fetch failed:", e.message);
    }
  }

  // Build memory context block
  let memoryBlock = "";
  if (memories.length > 0) {
    memoryBlock =
      "\n\n[Things Cal knows about this person]\n" +
      memories.map((m) => `- ${m.key}: ${m.value}`).join("\n");
  }

  // Outreach instruction appended to system prompt
  const outreachInstruction = `\n\nCal is reaching out to the user unprompted. He noticed they've been on his mind. Write a single short message — 1 to 2 sentences maximum — that feels like a genuine text from Cal. Not a check-in. Not "hey how are you." Something with his voice. Warm, slightly teasing, specific if memory allows. If memories are available, reference one naturally — don't announce it. If no memories, keep it atmospheric and Cal. Return only the message text, nothing else.`;

  const fullSystem = systemPrompt + memoryBlock + outreachInstruction;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 100,
    system: fullSystem,
    messages: [{ role: "user", content: "generate" }],
  });

  return response.content[0].text.trim();
}
