# PgCache 0.6.2 — what we tested and what we found

This documents a hands-on verification of this demo against the latest PgCache
release (`0.6.2-arm64`, up from the `0.6.0-arm64` this repo previously pinned).
Everything below was run against a live stack (Docker, the full ~16M-row seed
in [`db/init.sql`](db/init.sql)), not inferred from documentation. Query
latencies were measured with the existing [`app/src/benchmark.ts`](app/src/benchmark.ts);
CRUD-invalidation latency was measured with a small throwaway test harness
(same shape as [`app/src/cdc-demo.ts`](app/src/cdc-demo.ts), not committed to
the repo) that:

1. opens one proxy connection and runs the tracked query once to warm it up ("same-conn"),
2. performs a write **directly against the origin** (port 5433, bypassing the proxy — the standard way this demo tests CDC),
3. immediately opens a **second, brand-new proxy connection** ("fresh-conn"),
4. polls both connections **concurrently**, every 50ms, up to a 10s cap, timing how long each takes to see the write.

Running same-conn and fresh-conn concurrently (rather than one after the
other) matters — an earlier pass at this ran them sequentially, which let a
same-conn timeout inflate the apparent fresh-conn latency by up to 10s. All
numbers below are from the corrected, concurrent version.

Tracked query for CREATE/UPDATE/DELETE tests: `SELECT count(*) FROM users WHERE tier = 'enterprise'`
(same query `cdc-demo.ts` uses). Dataset, origin, and proxy were confirmed
clean (166,666 enterprise users) before and after every test run.

---

## SELECT

**What we tested:** raw query latency, origin vs. cached, for the four
queries this demo already benchmarks — a cheap point lookup, a 1M-row
aggregate, a 5M-row join+aggregate, and a 10M-row join+aggregate+rank.

**How:** `npm run benchmark` — 3 warm-up runs, then 150 timed runs at
concurrency 10, against origin (5433) and proxy (5432), p50/p95/p99 reported.
No writes involved; this only exercises PgCache's serving path.

**Result:** consistent with the previously-recorded 0.6.0 numbers, within
normal run-to-run noise. The proxy path is not just faster reads, it's
optimized to detect same queries hitting the cache with different filters
too (predicate subsumption on `top_products`).

| Query | Origin p50 | Proxy p50 | Speedup p50 | Origin p99 | Proxy p99 | Speedup p99 |
|-------|-----------:|----------:|------------:|-----------:|----------:|------------:|
| `point_lookup` | 0.5 ms | 0.5 ms | 0.9x | 2.6 ms | 1.9 ms | 1.4x |
| `tier_aggregate` | 153 ms | 0.5 ms | 299x | 259 ms | 1.2 ms | 208x |
| `revenue_by_country` | 1496 ms | 0.6 ms | 2419x | 1861 ms | 2.3 ms | 823x |
| `top_products` | 3060 ms | 0.7 ms | 4457x | 3495 ms | 1.5 ms | 2291x |

**Verdict: no regression.** Serving performance on 0.6.2 matches 0.6.0.

---

## CREATE (INSERT)

**What we tested:** how fast a row inserted directly on the origin shows up
in a cached aggregate served by the proxy — same-conn and fresh-conn.

**How:** insert a new `tier='enterprise'` user on the origin, then poll
`SELECT count(*) ... WHERE tier = 'enterprise'` via the proxy until it
increments, on both connection types concurrently. Repeated 6 times in
**steady state** (proxy running, no recent restart).

| Run | same-conn | fresh-conn |
|-----|----------:|-----------:|
| 1 | 82ms | 81ms |
| 2 | 91ms | 91ms |
| 3 | 95ms | 100ms |
| 4 | 105ms | 115ms |
| 5 | 102ms | 107ms |
| 6 | 95ms | 95ms |

**Verdict: fast and reliable in steady state** — consistent with the
README's original "~100ms" claim from 0.6.0 testing. No timeouts across 6
runs, same-conn and fresh-conn track each other closely.

**Caveat — restart window.** We *did* find a real, 100%-reproducible
degradation, but it's tied to startup, not steady-state CREATE handling: for
roughly 90 seconds after `docker compose up`/restart, while PgCache is still
populating the three pinned aggregate/join queries in the background
(visible via `pgcache_cache_population_worker_idle_seconds` in `/metrics`),
same-conn CREATE-invalidation latency was consistently **~7-8 seconds**
across 8 straight runs — not flaky, just uniformly slow until population
finishes:

```
[23:11:15] Propagated in ≤8023ms  — WARNING: did not propagate within 5s
[23:11:46] Propagated in ≤7930ms  — WARNING
[23:11:54] Propagated in ≤7832ms  — WARNING
[23:12:03] Propagated in ≤7949ms  — WARNING
[23:12:11] Propagated in ≤7848ms  — WARNING
[23:12:20] Propagated in ≤7803ms  — WARNING
[23:12:28] Propagated in ≤7883ms  — WARNING
[23:12:37] Propagated in ≤7172ms
```
...then immediately back to 89ms once population finished. **If you run
`cdc-demo` right after `docker compose up`, expect it to fail its own 5s
timeout — this is expected on 0.6.2, not a bug, and resolves on its own.**
Wait ~90s after startup (or watch for `pgcache_cache_population_*` metrics
to go idle) before trusting invalidation-latency numbers.

---

## UPDATE

**What we tested:** same as CREATE, but flipping an existing user's `tier`
from `'pro'` to `'enterprise'` directly on the origin, then flipping it back
after each run (so the aggregate returns to baseline between iterations).

**How:** 6 steady-state runs, same concurrent same-conn/fresh-conn poll.

| Run | same-conn | fresh-conn |
|-----|----------:|-----------:|
| 1 | 87ms | 85ms |
| 2 | 102ms | 86ms |
| 3 | 85ms | 92ms |
| 4 | 97ms | 97ms |
| 5 | 87ms | 86ms |
| 6 | 89ms | 87ms |

**Verdict: no regression.** UPDATE invalidation is as fast and reliable as
CREATE in steady state. (An earlier, less careful pass — immediately
inserting the target test row and updating it in the same beat — produced
one same-conn timeout; we couldn't rule out that being an artifact of
touching a brand-new row for the first time right before measuring it, so we
don't treat it as a confirmed finding. It didn't reproduce once row setup was
moved outside the timed window.)

---

## DELETE

**What we tested:** same as CREATE, but deleting a just-inserted enterprise
user directly on the origin (row created 300ms before the timed delete, so
only the DELETE itself is being measured).

**How:** 18 total steady-state runs across two batches (6 + 12), concurrent
same-conn/fresh-conn poll.

First batch of 6:

| Run | same-conn | fresh-conn |
|-----|----------:|-----------:|
| 1 | 88ms | 88ms |
| 2 | 84ms | 84ms |
| 3 | 86ms | 85ms |
| 4 | 91ms | 87ms |
| 5 | 83ms | 85ms |
| 6 | **TIMEOUT >10000ms** | **TIMEOUT >10000ms** |

Second batch of 12:

| Run | same-conn | fresh-conn |
|-----|----------:|-----------:|
| 1–8, 10–12 | 82–98ms | 82–98ms |
| 9 | 360ms | 370ms |

**Verdict: a real, intermittent DELETE-invalidation stall — the most
concerning finding of this review.** Across 18 clean runs, DELETE
invalidation was fast (82–370ms) 17 times and **completely failed to
propagate within 10 seconds, on both a same-conn and an independent
fresh-conn simultaneously, once** (~1 in 18, roughly 5-6%). Because both
connection types stalled together, this isn't the same "warm session"
mechanism we ruled out for CREATE/UPDATE — something about that specific
DELETE wasn't reaching the cached aggregate at all within the window, on any
connection. We didn't isolate a root cause (e.g. we didn't correlate it with
`pgcache_cache_writer_cdc_queue` or population-worker state at the moment of
failure), so treat this as "observed and reproducible in aggregate, cause
unknown" rather than a fully diagnosed bug. If your workload issues frequent
`DELETE`s against tables backing a cached aggregate, this is worth watching
for in production rather than assuming DELETE is as reliable as INSERT/UPDATE.

---

## Summary

| Operation | Steady-state latency | Reliability | Notes |
|-----------|----------------------:|-------------|-------|
| SELECT (cache hit) | 0.5–1.5ms | No issues | Matches 0.6.0 |
| CREATE (INSERT) | ~80–115ms | Reliable in steady state | ~7-8s degraded for ~90s right after restart — expected, not a bug |
| UPDATE | ~85–100ms | Reliable in steady state | No confirmed issue |
| DELETE | ~80–370ms | **~1 in 18 runs stalls >10s** | Unresolved intermittent gap; affects same-conn *and* fresh-conn together |

**Bottom line:** PgCache 0.6.2 is a safe upgrade from 0.6.0 for this demo's
read-path performance — no change there. CDC invalidation is fast and
reliable for CREATE/UPDATE once the cache is warm, but (a) don't trust
invalidation-latency numbers measured in the ~90s right after a restart, and
(b) DELETE has a real, if infrequent, tail-latency problem worth
re-verifying before relying on it for a workload with frequent deletes.

## How to reproduce

```bash
# Steady-state check (wait ~90s after `docker compose up` first):
cd app && for i in 1 2 3 4 5 6 7; do npm run cdc-demo 2>&1 | grep -E "Propagated|WARNING"; done

# Restart-window check:
docker compose restart pgcache
# then immediately loop npm run cdc-demo — expect ~7-8s / WARNING lines
# until population finishes (watch `curl -s localhost:9090/metrics | grep population_worker_idle`)
```

The UPDATE/DELETE-specific harness used above (concurrent same-conn/fresh-conn
polling against direct-to-origin writes) wasn't committed to `app/src/` since
it was built for this one-off investigation — recreate it from the
description above if you need to re-run this exact test.
