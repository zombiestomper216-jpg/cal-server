// One-off: re-embed user_id 3's high-confidence memories into memory_embeddings.
//
// Read-only by default (pre-flight report). Pass --confirm to actually write
// embeddings. Pass --verify to run the retrieval probes.
//
// Env (from `railway run`): DATABASE_URL (memories), SUPABASE_DATABASE_URL
// (memory_embeddings), VOYAGE_API_KEY.
//
// Mirrors index.js: generateVoyageEmbedding (voyage-3-lite, 512-dim) and the
// (user_id, memory_key) upsert. No schema change; mode is read from memories at
// retrieval, not stored on the embedding.

import pg from 'pg';

const USER_ID = 3;
const CONFIRM = process.argv.includes('--confirm');
const VERIFY = process.argv.includes('--verify');
const TARGET_IDS = [976, 977, 978, 983, 988];
const THROTTLE_MS = 350;

const { DATABASE_URL, SUPABASE_DATABASE_URL, VOYAGE_API_KEY } = process.env;

function fail(msg) { console.error(`\n[FATAL] ${msg}`); process.exit(1); }
if (!DATABASE_URL) fail('DATABASE_URL not set');
if (!SUPABASE_DATABASE_URL) fail('SUPABASE_DATABASE_URL not set');
if (!VOYAGE_API_KEY) fail('VOYAGE_API_KEY not set');

const dbWantsSsl = /sslmode=require/i.test(DATABASE_URL);
const db = new pg.Pool({
  connectionString: DATABASE_URL,
  ...(dbWantsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  max: 3, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000,
});
const supabaseDb = new pg.Pool({
  connectionString: SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000,
});

async function generateVoyageEmbedding(text) {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'voyage-3-lite', input: text }),
  });
  const data = await response.json();
  if (!data.data || !data.data[0]) throw new Error(`Voyage API error (${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return data.data[0].embedding;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function preflight() {
  console.log('=== PRE-FLIGHT (read-only) ===');

  // Connectivity gate — this is also the Step 0 reachability test for the home server.
  let total, high;
  try {
    total = (await db.query('SELECT count(*)::int AS n FROM memories WHERE user_id = $1', [USER_ID])).rows[0].n;
    high = (await db.query("SELECT count(*)::int AS n FROM memories WHERE user_id = $1 AND confidence = 'high'", [USER_ID])).rows[0].n;
  } catch (e) {
    fail(`Cannot reach memories DB (DATABASE_URL): ${e.code || ''} ${e.message}\n` +
         `If this is ECONNREFUSED/timeout, \`railway run\` is executing locally and cannot reach the\n` +
         `home server. Switch to the in-prod admin-endpoint fallback (see plan).`);
  }
  console.log(`memories WHERE user_id=${USER_ID}              : ${total}`);
  console.log(`  ...AND confidence='high' (embed set)        : ${high}`);

  const since = (await db.query(
    "SELECT count(*)::int AS n FROM memories WHERE user_id=$1 AND (created_at >= '2026-05-28' OR updated_at >= '2026-05-28')",
    [USER_ID])).rows[0].n;
  console.log(`  ...added/changed since 2026-05-28           : ${since}`);

  // The 5 rows the user flagged — if any are NOT 'high', high-only embedding skips them.
  console.log(`\n-- confidence on flagged ids ${TARGET_IDS.join(', ')} --`);
  const targets = await db.query(
    'SELECT id, key, confidence, mode, type, left(value, 60) AS value_head FROM memories WHERE id = ANY($1::int[]) ORDER BY id',
    [TARGET_IDS]);
  const foundIds = new Set(targets.rows.map((r) => r.id));
  for (const r of targets.rows) {
    const flag = r.confidence === 'high' ? 'OK ' : '>>> NOT HIGH (will be SKIPPED)';
    console.log(`  id ${r.id} [${flag}] conf=${r.confidence} mode=${r.mode} type=${r.type} key=${r.key}`);
    console.log(`        "${r.value_head}"`);
  }
  for (const id of TARGET_IDS) if (!foundIds.has(id)) console.log(`  id ${id} >>> NOT FOUND for user_id=${USER_ID}`);

  // Data hygiene on the embed set.
  const bad = (await db.query(
    "SELECT count(*)::int AS n FROM memories WHERE user_id=$1 AND confidence='high' AND (key IS NULL OR value IS NULL OR btrim(value) = '')",
    [USER_ID])).rows[0].n;
  console.log(`\nhigh-confidence rows with NULL/empty key or value (will skip): ${bad}`);

  const dups = await db.query(
    "SELECT key, count(*)::int AS c FROM memories WHERE user_id=$1 AND confidence='high' GROUP BY key HAVING count(*) > 1",
    [USER_ID]);
  console.log(`duplicate high-confidence keys (upsert collapses these): ${dups.rows.length}` +
    (dups.rows.length ? ` -> ${dups.rows.map((d) => `${d.key}x${d.c}`).join(', ')}` : ''));
  const distinctHigh = (await db.query(
    "SELECT count(DISTINCT key)::int AS n FROM memories WHERE user_id=$1 AND confidence='high' AND value IS NOT NULL AND btrim(value) <> ''",
    [USER_ID])).rows[0].n;
  console.log(`distinct embeddable high-confidence keys (expected upsert count): ${distinctHigh}`);

  // Current index size.
  let embUser, embTotal;
  try {
    embUser = (await supabaseDb.query('SELECT count(*)::int AS n FROM memory_embeddings WHERE user_id = $1', [USER_ID])).rows[0].n;
    embTotal = (await supabaseDb.query('SELECT count(*)::int AS n FROM memory_embeddings')).rows[0].n;
  } catch (e) {
    fail(`Cannot reach embeddings DB (SUPABASE_DATABASE_URL): ${e.code || ''} ${e.message}`);
  }
  console.log(`\nmemory_embeddings WHERE user_id=${USER_ID} (current) : ${embUser}`);
  console.log(`memory_embeddings total (current)            : ${embTotal}`);

  // Prove model + dim before any write.
  const probe = await generateVoyageEmbedding('dimension check');
  console.log(`\nVoyage model: voyage-3-lite   embedding dim: ${probe.length} (expected 512)`);
  console.log(`upsert join key: (user_id, memory_key)  ON CONFLICT (user_id, memory_key) DO UPDATE`);
  if (probe.length !== 512) fail(`Embedding dim ${probe.length} != 512 — would make the index inconsistent. Aborting.`);

  console.log(`\n=== STOP. Review the numbers above. Re-run with --confirm to embed. ===`);
}

async function embed() {
  console.log('=== EMBED (--confirm) ===');
  const { rows } = await db.query(
    "SELECT id, key, value, type, mode, updated_at FROM memories WHERE user_id=$1 AND confidence='high' AND value IS NOT NULL AND btrim(value) <> '' ORDER BY id",
    [USER_ID]);

  // Dedupe by key, keep newest updated_at.
  const byKey = new Map();
  for (const r of rows) {
    const prev = byKey.get(r.key);
    if (!prev || new Date(r.updated_at) > new Date(prev.updated_at)) byKey.set(r.key, r);
  }
  const work = [...byKey.values()];
  console.log(`rows=${rows.length} distinct-keys=${work.length}`);

  let embedded = 0, failed = 0, firstError = null;
  for (const r of work) {
    try {
      const emb = await generateVoyageEmbedding(r.value);
      await supabaseDb.query(
        `INSERT INTO memory_embeddings (user_id, memory_key, embedding, updated_at)
         VALUES ($1, $2, $3::vector, NOW())
         ON CONFLICT (user_id, memory_key)
         DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = NOW()`,
        [USER_ID, r.key, JSON.stringify(emb)]);
      embedded++;
      if (embedded % 10 === 0 || embedded === work.length) console.log(`  ...${embedded}/${work.length}`);
    } catch (e) {
      failed++;
      if (!firstError) firstError = `${r.key}: ${e.message}`;
      console.error(`  FAIL ${r.key}: ${e.message}`);
    }
    await sleep(THROTTLE_MS);
  }
  console.log(`\nembedded=${embedded} failed=${failed} total=${work.length} firstError=${firstError || 'none'}`);

  const embUser = (await supabaseDb.query('SELECT count(*)::int AS n FROM memory_embeddings WHERE user_id=$1', [USER_ID])).rows[0].n;
  console.log(`memory_embeddings WHERE user_id=${USER_ID} (new): ${embUser}`);
}

async function verify() {
  console.log('\n=== RETRIEVAL CHECK ===');
  for (const q of ['presence mode', 'Max']) {
    const qe = await generateVoyageEmbedding(q);
    const { rows } = await supabaseDb.query(
      'SELECT memory_key FROM memory_embeddings WHERE user_id=$1 ORDER BY embedding <=> $2::vector LIMIT 10',
      [USER_ID, JSON.stringify(qe)]);
    const keys = rows.map((r) => r.memory_key);
    const mem = await db.query('SELECT key, mode, left(value, 80) AS v FROM memories WHERE user_id=$1 AND key = ANY($2::text[])', [USER_ID, keys]);
    const byKey = new Map(mem.rows.map((m) => [m.key, m]));
    console.log(`\nquery "${q}" -> top ${keys.length}:`);
    for (const k of keys) {
      const m = byKey.get(k);
      console.log(`  [${m?.mode ?? '?'}] ${k}: "${m?.v ?? '(key not in memories)'}"`);
    }
  }
}

(async () => {
  try {
    if (CONFIRM) { await embed(); await verify(); }
    else { await preflight(); if (VERIFY) await verify(); }
  } catch (e) {
    console.error('[ERROR]', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
    await supabaseDb.end().catch(() => {});
  }
})();
