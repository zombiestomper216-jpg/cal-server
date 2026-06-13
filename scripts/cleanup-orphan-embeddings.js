// Cleanup orphan embeddings for user_id 3: rows in memory_embeddings whose
// memory_key has no matching row in memories.
//
// Dry-run by default (read-only). Pass --confirm to delete.
// Run via: railway run node scripts/cleanup-orphan-embeddings.js [--confirm]
//
// memories -> DATABASE_URL ; memory_embeddings -> SUPABASE_DATABASE_URL.
// Cross-DB: fetch the memories keyset from DATABASE_URL, then delete from
// SUPABASE_DATABASE_URL where memory_key is NOT in that fetched set.
//
// SAFETY: if the fetched memories keyset is empty OR not exactly 353 keys,
// ABORT the delete. `<> ALL(empty array)` would match every row, so an empty
// keyset must never reach the DELETE.

import pg from 'pg';

const USER_ID = 3;
const EXPECTED_KEYSET = 353;
const EXPECTED_ORPHANS = 139;
const CONFIRM = process.argv.includes('--confirm');

const { DATABASE_URL, SUPABASE_DATABASE_URL, VOYAGE_API_KEY } = process.env;
if (!DATABASE_URL) { console.error('[FATAL] DATABASE_URL not set'); process.exit(1); }
if (!SUPABASE_DATABASE_URL) { console.error('[FATAL] SUPABASE_DATABASE_URL not set'); process.exit(1); }

const db = new pg.Pool({
  connectionString: DATABASE_URL,
  ...(/sslmode=require/i.test(DATABASE_URL) ? { ssl: { rejectUnauthorized: false } } : {}),
  max: 2, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000,
});
const supabaseDb = new pg.Pool({
  connectionString: SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000,
});

async function generateVoyageEmbedding(text) {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'voyage-3-lite', input: text }),
  });
  const data = await response.json();
  if (!data.data || !data.data[0]) throw new Error(`Voyage API error (${response.status})`);
  return data.data[0].embedding;
}

async function presenceProbe() {
  console.log('\n=== retrieval probe: "presence mode" (top 10) ===');
  const qe = await generateVoyageEmbedding('presence mode');
  const near = await supabaseDb.query(
    'SELECT memory_key FROM memory_embeddings WHERE user_id=$1 ORDER BY embedding <=> $2::vector LIMIT 10',
    [USER_ID, JSON.stringify(qe)]);
  const keys = near.rows.map(r => r.memory_key);
  const mem = await db.query('SELECT key, mode, left(value,80) v FROM memories WHERE user_id=$1 AND key = ANY($2::text[])', [USER_ID, keys]);
  const byKey = new Map(mem.rows.map(m => [m.key, m]));
  let misses = 0;
  for (const k of keys) {
    const m = byKey.get(k);
    if (!m) misses++;
    console.log(`  [${m?.mode ?? '?'}] ${k}: "${m?.v ?? '(key not in memories)'}"`);
  }
  console.log(`  -> "(key not in memories)" entries in top 10: ${misses}`);
  return misses;
}

(async () => {
  try {
    // Fetch current memories keyset (the keep-list) from DATABASE_URL.
    const memRes = await db.query('SELECT DISTINCT key FROM memories WHERE user_id = $1', [USER_ID]);
    const keepKeys = memRes.rows.map(r => r.key).filter(k => k != null);
    console.log(`memories keyset (user_id=${USER_ID}): ${keepKeys.length}`);

    // Embedding side.
    const embRes = await supabaseDb.query('SELECT memory_key FROM memory_embeddings WHERE user_id = $1', [USER_ID]);
    const embTotal = embRes.rows.length;
    const keepSet = new Set(keepKeys);
    const orphans = [...new Set(embRes.rows.map(r => r.memory_key))].filter(k => !keepSet.has(k));
    const remainAfter = embTotal - embRes.rows.filter(r => !keepSet.has(r.memory_key)).length;

    console.log(`\n=== STEP 1 — DRY-RUN (read-only) ===`);
    console.log(`memory_embeddings rows user_id=${USER_ID} (current): ${embTotal}`);
    console.log(`orphan keys (in embeddings, NOT in memories): ${orphans.length}` +
      (orphans.length === EXPECTED_ORPHANS ? `  ✓ matches diagnosis (${EXPECTED_ORPHANS})` : `  != ${EXPECTED_ORPHANS} from diagnosis`));
    console.log(`rows that WOULD remain after deletion: ${remainAfter}` +
      (remainAfter === EXPECTED_KEYSET ? `  ✓ equals memories keyset (${EXPECTED_KEYSET})` : `  != ${EXPECTED_KEYSET}`));
    console.log(`\n--- full orphan key list (${orphans.length}) ---`);
    orphans.forEach((k, i) => console.log(`  ${String(i + 1).padStart(3)}. ${k}`));

    if (!CONFIRM) {
      console.log(`\n=== STOP. Dry-run only. Re-run with --confirm to delete. ===`);
      return;
    }

    // ---- STEP 2 — DELETE (guarded) ----
    console.log(`\n=== STEP 2 — DELETE (--confirm) ===`);
    if (keepKeys.length === 0) { console.error('[ABORT] memories keyset is EMPTY — refusing to delete (would wipe all rows).'); process.exitCode = 1; return; }
    if (keepKeys.length !== EXPECTED_KEYSET) { console.error(`[ABORT] memories keyset is ${keepKeys.length}, expected ${EXPECTED_KEYSET}. Refusing to delete.`); process.exitCode = 1; return; }

    const del = await supabaseDb.query(
      'DELETE FROM memory_embeddings WHERE user_id = $1 AND memory_key <> ALL($2::text[])',
      [USER_ID, keepKeys]);
    console.log(`rows deleted: ${del.rowCount} (expected ${EXPECTED_ORPHANS})`);

    const after = await supabaseDb.query('SELECT count(*)::int n FROM memory_embeddings WHERE user_id = $1', [USER_ID]);
    console.log(`memory_embeddings user_id=${USER_ID} (new): ${after.rows[0].n} (expected ${EXPECTED_KEYSET})`);

    await presenceProbe();
  } catch (e) {
    console.error('[ERROR]', e.code || '', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
    await supabaseDb.end().catch(() => {});
  }
})();
