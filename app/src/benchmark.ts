import { ALL_QUERIES, makeOriginPool, makeProxyPool, ORIGIN_PORT, PROXY_PORT, Query } from "./queries";
import { Pool } from "pg";

const CONCURRENCY = 10;
const ITERATIONS = 150; // per query per target
const WARMUP_RUNS = 3;  // runs before measuring (populates cache)

interface Stats {
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  min: number;
  max: number;
  qps: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(latenciesMs: number[], wallTimeMs: number): Stats {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    avg: Math.round(avg * 10) / 10,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    qps: Math.round((sorted.length / (wallTimeMs / 1000)) * 10) / 10,
  };
}

async function runQuery(pool: Pool, query: Query): Promise<number> {
  const client = await pool.connect();
  const start = performance.now();
  try {
    await query.run(client);
  } finally {
    client.release();
  }
  return performance.now() - start;
}

async function warmUp(pool: Pool, query: Query): Promise<void> {
  for (let i = 0; i < WARMUP_RUNS; i++) {
    await runQuery(pool, query);
  }
}

async function measureQuery(pool: Pool, query: Query): Promise<{ latencies: number[]; wallTimeMs: number }> {
  const allLatencies: number[] = [];
  const totalBatches = Math.ceil(ITERATIONS / CONCURRENCY);
  const wallStart = performance.now();
  for (let b = 0; b < totalBatches; b++) {
    const batchSize = Math.min(CONCURRENCY, ITERATIONS - b * CONCURRENCY);
    const batch = Array.from({ length: batchSize }, () => runQuery(pool, query));
    const latencies = await Promise.all(batch);
    allLatencies.push(...latencies);
  }
  return { latencies: allLatencies, wallTimeMs: performance.now() - wallStart };
}

function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function printResult(label: string, query: Query, stats: Stats): void {
  console.log(`  ${label.padEnd(10)} │ p50=${formatMs(stats.p50).padStart(8)} │ p95=${formatMs(stats.p95).padStart(8)} │ p99=${formatMs(stats.p99).padStart(8)} │ avg=${formatMs(stats.avg).padStart(8)}`);
}

async function benchmarkQuery(
  originPool: Pool,
  proxyPool: Pool,
  query: Query
): Promise<{ origin: Stats; proxy: Stats }> {
  process.stdout.write(`\n  [${query.name}] ${query.description}\n`);

  // Warm up proxy cache first
  process.stdout.write("  Warming up proxy cache...");
  await warmUp(proxyPool, query);
  console.log(" done");

  // Measure origin (cold, direct)
  process.stdout.write("  Measuring origin...");
  const originResult = await measureQuery(originPool, query);
  console.log(` done (${originResult.latencies.length} runs)`);

  // Measure proxy (warm cache)
  process.stdout.write("  Measuring proxy (warm cache)...");
  const proxyResult = await measureQuery(proxyPool, query);
  console.log(` done (${proxyResult.latencies.length} runs)`);

  return {
    origin: computeStats(originResult.latencies, originResult.wallTimeMs),
    proxy: computeStats(proxyResult.latencies, proxyResult.wallTimeMs),
  };
}

async function main(): Promise<void> {
  const originPool = makeOriginPool();
  const proxyPool = makeProxyPool();

  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log(` PgCache Benchmark — origin (port ${ORIGIN_PORT}) vs proxy/cache (port ${PROXY_PORT})`);
  console.log(` Concurrency: ${CONCURRENCY}  Iterations: ${ITERATIONS}  Warmup runs: ${WARMUP_RUNS}`);
  console.log("═══════════════════════════════════════════════════════════════════════════");

  const results: Array<{ query: Query; origin: Stats; proxy: Stats }> = [];

  for (const query of ALL_QUERIES) {
    const { origin, proxy } = await benchmarkQuery(originPool, proxyPool, query);
    results.push({ query, origin, proxy });
  }

  console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
  console.log(" RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════════════════");

  for (const { query, origin, proxy } of results) {
    const p99Speedup = (origin.p99 / proxy.p99).toFixed(1);
    const p50Speedup = (origin.p50 / proxy.p50).toFixed(1);
    console.log(`\n  ── ${query.name} ──────────────────────────────────────────`);
    console.log(`  ${query.description}`);
    printResult("origin", query, origin);
    printResult("proxy", query, proxy);
    console.log(`  Speedup:   p50 = ${p50Speedup}x   p99 = ${p99Speedup}x`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════════════════");

  // Machine-readable JSON for the post/charts
  const jsonResults = results.map(({ query, origin, proxy }) => ({
    query: query.name,
    description: query.description,
    origin_p50_ms: origin.p50,
    origin_p95_ms: origin.p95,
    origin_p99_ms: origin.p99,
    proxy_p50_ms: proxy.p50,
    proxy_p95_ms: proxy.p95,
    proxy_p99_ms: proxy.p99,
    p50_speedup: parseFloat((origin.p50 / proxy.p50).toFixed(2)),
    p99_speedup: parseFloat((origin.p99 / proxy.p99).toFixed(2)),
  }));

  const fs = await import("fs");
  const resultsPath = "./results.json";
  fs.writeFileSync(resultsPath, JSON.stringify(jsonResults, null, 2));
  console.log(`\n Results written to ${resultsPath}`);

  await originPool.end();
  await proxyPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
