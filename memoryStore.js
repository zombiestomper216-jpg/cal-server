// memoryStore.js
import fs from "fs";
import path from "path";

const MEMORY_PATH = path.join(process.cwd(), "memory.json");

// ---- Helpers ----
function safeReadJSON(filepath, fallback) {
  try {
    if (!fs.existsSync(filepath)) return fallback;
    const raw = fs.readFileSync(filepath, "utf8");
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJSON(filepath, data) {
  const tmp = filepath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filepath);
}

// ---- Shape ----
// memory.json will look like:
// {
//   "users": {
//     "user_abc": { "mode": "SFW", "history": [ ... ] }
//   }
// }

export function loadMemoryDb() {
  return safeReadJSON(MEMORY_PATH, { users: {} });
}

export function saveMemoryDb(db) {
  safeWriteJSON(MEMORY_PATH, db);
}

export function getUserState(db, userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      mode: "SFW",
      history: [],
    };
  }
  return db.users[userId];
}

export function trimHistory(history, maxMessages = 24) {
  if (!Array.isArray(history)) return [];
  if (history.length <= maxMessages) return history;
  return history.slice(history.length - maxMessages);
}
