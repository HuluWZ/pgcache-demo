import { makeOriginPool, makeProxyPool } from "./queries";

const POLL_INTERVAL_MS = 50;
const MAX_WAIT_MS = 5000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const originPool = makeOriginPool();
  const proxyPool = makeProxyPool();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(" PgCache CDC (Change Data Capture) Invalidation Demo");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Use a unique email so this demo is re-runnable
  const testEmail = `cdc_demo_${Date.now()}@test.com`;

  // 1. Warm up the cache with the aggregate query
  console.log("1. Warming up cache (running aggregate query via proxy)...");
  const proxyClient = await proxyPool.connect();
  const originClient = await originPool.connect();

  const countQuery = `SELECT count(*) AS n FROM users WHERE tier = 'enterprise'`;

  await proxyClient.query(countQuery); // first pass — may be a cache miss
  const { rows: warmRows } = await proxyClient.query(countQuery); // second — should be cached
  const before = parseInt(warmRows[0].n, 10);
  console.log(`   Cached count (enterprise users via proxy): ${before.toLocaleString()}\n`);

  // 2. Write directly to origin (bypassing the proxy)
  console.log("2. Writing a new enterprise user directly to origin (bypassing proxy)...");
  await originClient.query(
    `INSERT INTO users (email, username, country, tier) VALUES ($1, $2, 'US', 'enterprise')`,
    [testEmail, "cdc_demo_user"]
  );
  const writeTs = performance.now();
  console.log(`   Inserted: ${testEmail}\n`);

  // 3. Poll the proxy until the count updates — measure invalidation latency
  console.log("3. Polling proxy until CDC invalidation propagates...");
  let elapsed = 0;
  let after = before;
  while (elapsed < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;
    const { rows } = await proxyClient.query(countQuery);
    after = parseInt(rows[0].n, 10);
    if (after > before) break;
    process.stdout.write(`   ${elapsed}ms — still ${after.toLocaleString()}\r`);
  }

  const invalidationLatencyMs = performance.now() - writeTs;
  console.log(`\n   Propagated in ≤${Math.round(invalidationLatencyMs)}ms`);
  console.log(`   Count before: ${before.toLocaleString()}`);
  console.log(`   Count after:  ${after.toLocaleString()} (+${after - before})\n`);

  if (after === before) {
    console.log("   WARNING: CDC did not propagate within 5s — check replication slot.");
  } else {
    console.log("   ✓ Cache invalidated and result updated — no stale reads.");
  }

  // 4. Cleanup
  await originClient.query(`DELETE FROM users WHERE email = $1`, [testEmail]);
  console.log(`\n   Cleaned up test row.`);

  originClient.release();
  proxyClient.release();
  await originPool.end();
  await proxyPool.end();

  console.log("\n═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
