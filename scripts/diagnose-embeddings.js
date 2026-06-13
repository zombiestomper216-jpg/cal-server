// READ-ONLY diagnosis of memory_embeddings duplication + orphans for user_id 3.
// No writes, no deletes. Run via: railway run node scripts/diagnose-embeddings.js
//
// memories -> DATABASE_URL ; memory_embeddings -> SUPABASE_DATABASE_URL.
// Cross-DB, so orphan detection diffs distinct keys in JS.

import pg from 'pg';

const USER_ID = 3;
const SUSPECT_KEYS = ['april12_key_significance', 'cal_self_concept_anchor', 'joey_house_cal_reaction'];

const { DATABASE_URL, SUPABASE_DATABASE_URL } = process.env;
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

(async () => {
  try {
    // ---- 1. Constraints + indexes + columns on memory_embeddings ----
    console.log('=== 1. memory_embeddings constraints ===');
    const cons = await supabaseDb.query(
      `SELECT conname, contype, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid = 'memory_embeddings'::regclass ORDER BY contype`);
    if (!cons.rows.length) console.log('  (NO constraints found)');
    for (const c of cons.rows) console.log(`  ${c.conname} [${c.contype}] ${c.def}`);

    console.log('\n--- indexes (ON CONFLICT can also target a UNIQUE INDEX) ---');
    const idx = await supabaseDb.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'memory_embeddings'`);
    if (!idx.rows.length) console.log('  (no indexes)');
    for (const i of idx.rows) console.log(`  ${i.indexname}: ${i.indexdef}`);

    console.log('\n--- columns ---');
    const cols = await supabaseDb.query(
      `SELECT column_name, data_type, column_default FROM information_schema.columns
       WHERE table_name = 'memory_embeddings' ORDER BY ordinal_position`);
    for (const c of cols.rows) console.log(`  ${c.column_name} ${c.data_type}${c.column_default ? ' DEFAULT ' + c.column_default : ''}`);

    const hasUniqueOnPair = cons.rows.some(c =>
      (c.contype === 'u' || c.contype === 'p') && /\(user_id,\s*memory_key\)/i.test(c.def))
      || idx.rows.some(i => /UNIQUE/i.test(i.indexdef) && /\(user_id,\s*memory_key\)/i.test(i.indexdef));
    console.log(`\n>> UNIQUE/PK on (user_id, memory_key): ${hasUniqueOnPair ? 'YES' : 'NO — ON CONFLICT target cannot fire; every run inserts'}`);

    // ---- 2. Duplicate (user_id, memory_key) pairs ----
    console.log('\n=== 2. duplicate (user_id, memory_key) for user_id=3 ===');
    const dups = await supabaseDb.query(
      `SELECT user_id, memory_key, count(*) AS c
       FROM memory_embeddings WHERE user_id = $1
       GROUP BY user_id, memory_key HAVING count(*) > 1
       ORDER BY c DESC LIMIT 20`, [USER_ID]);
    const dupCount = await supabaseDb.query(
      `SELECT count(*)::int AS dup_keys, coalesce(sum(c),0)::int AS extra_rows FROM (
         SELECT count(*) - 1 AS c FROM memory_embeddings WHERE user_id = $1
         GROUP BY user_id, memory_key HAVING count(*) > 1) t`, [USER_ID]);
    const totals = await supabaseDb.query(
      `SELECT count(*)::int AS total_rows, count(DISTINCT memory_key)::int AS distinct_keys
       FROM memory_embeddings WHERE user_id = $1`, [USER_ID]);
    console.log(`  total rows user_id=3      : ${totals.rows[0].total_rows}`);
    console.log(`  distinct memory_key       : ${totals.rows[0].distinct_keys}`);
    console.log(`  keys with duplicates      : ${dupCount.rows[0].dup_keys}`);
    console.log(`  surplus (redundant) rows  : ${dupCount.rows[0].extra_rows}`);
    console.log('  top duplicated keys:');
    if (!dups.rows.length) console.log('    (none)');
    for (const d of dups.rows) console.log(`    ${d.memory_key} x${d.c}`);

    // ---- 3. Orphans: embedding keys with no matching memories row ----
    console.log('\n=== 3. orphan embeddings (key absent from memories) ===');
    const embKeys = await supabaseDb.query(
      `SELECT DISTINCT memory_key FROM memory_embeddings WHERE user_id = $1`, [USER_ID]);
    const memKeys = await db.query(
      `SELECT DISTINCT key FROM memories WHERE user_id = $1`, [USER_ID]);
    const memSet = new Set(memKeys.rows.map(r => r.key));
    const embSet = new Set(embKeys.rows.map(r => r.memory_key));
    const orphans = [...embSet].filter(k => !memSet.has(k));
    const missingFromIndex = [...memSet].filter(k => !embSet.has(k));
    console.log(`  distinct embedding keys (user_id=3): ${embSet.size}`);
    console.log(`  distinct memories keys  (user_id=3): ${memSet.size}`);
    console.log(`  ORPHAN embedding keys (not in memories): ${orphans.length}`);
    for (const k of orphans.slice(0, 50)) console.log(`    - ${k}`);
    if (orphans.length > 50) console.log(`    ... +${orphans.length - 50} more`);
    console.log(`  memories keys MISSING from index: ${missingFromIndex.length}`);
    for (const k of missingFromIndex.slice(0, 50)) console.log(`    - ${k}`);

    // ---- suspect keys named in the probe ----
    console.log('\n=== suspect keys from retrieval probe ===');
    for (const k of SUSPECT_KEYS) {
      const inMem = memSet.has(k);
      const embRows = await supabaseDb.query(
        `SELECT count(*)::int AS c FROM memory_embeddings WHERE user_id = $1 AND memory_key = $2`, [USER_ID, k]);
      console.log(`  ${k}: in memories=${inMem ? 'YES' : 'NO'}  embedding rows=${embRows.rows[0].c}`);
    }
  } catch (e) {
    console.error('[ERROR]', e.code || '', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
    await supabaseDb.end().catch(() => {});
  }
})();
