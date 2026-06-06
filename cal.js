import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Main Cal message handler
 *
 * @param {Object} params
 * @param {string} params.mode - "sfw" or "after_dark"
 * @param {string|Array} params.systemPrompt - Fully assembled system prompt (built by index.js).
 *   May be a plain string or an array of Anthropic content blocks (used for prompt caching).
 * @param {Array} params.conversationHistory - Array of {role, content} objects (includes latest user message)
 */
export async function sendMessageToCal({
  mode = "sfw",
  systemPrompt,
  conversationHistory = [],
}) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: systemPrompt,
    messages: conversationHistory,
  });

  console.log('[TOKENS]', {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cache_creation: response.usage.cache_creation_input_tokens,
    cache_read: response.usage.cache_read_input_tokens,
    total: response.usage.input_tokens + response.usage.output_tokens
  });

  const reply = response.content[0].text;

  return {
    reply,
    updatedHistory: [
      ...conversationHistory,
      { role: "assistant", content: reply },
    ],
  };
}

/**
 * Easter egg handler — checks if user guessed Cal's real name
 */
export function checkEasterEgg(userMessage) {
  const normalized = userMessage.toLowerCase().replace(/[^a-z]/g, "");
  const triggers = ["kalel", "superman", "kryptonian", "krypton"];
  return triggers.some((t) => normalized.includes(t));
}
