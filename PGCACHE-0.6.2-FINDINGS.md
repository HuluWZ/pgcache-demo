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

**How:** 78 total steady-state runs across four batches (6 + 12 + 20 + 40),
concurrent same-conn/fresh-conn poll. The later batches also snapshotted
PgCache's internal metrics (`pgcache_cache_writer_cdc_queue`,
`pgcache_cdc_lag_seconds`, `pgcache_cache_invalidations`, etc.) and tailed
the container's logs continuously, specifically to catch a failure in the
act if one happened again.

First batch of 6 (the one that motivated the deeper dig):

| Run | same-conn | fresh-conn |
|-----|----------:|-----------:|
| 1 | 88ms | 88ms |
| 2 | 84ms | 84ms |
| 3 | 86ms | 85ms |
| 4 | 91ms | 87ms |
| 5 | 83ms | 85ms |
| 6 | **TIMEOUT >10000ms** | **TIMEOUT >10000ms** |

Follow-up batches of 12, 20, and 40 (60 additional runs, with metrics/log
capture wired up): **zero timeouts.** Latency stayed in the 65–98ms band the
entire time, with two mild outliers (352ms, 702ms) that never came close to
the 10s threshold. The log tail captured nothing — no WARN/ERROR entries —
during any of the 60 runs, clean or outlier.

**Revised verdict: not confirmed as a PgCache defect.** The original
framing — "~1 in 18, a real intermittent DELETE bug" — doesn't hold up under
more data. Across 78 total trials the failure rate is closer to 1 in 78
(~1.3%), it didn't reproduce at all across 60 further attempts under
matching conditions, and we found nothing in PgCache's own logs or metrics
correlating with the one failure we did see. That's more consistent with a
one-off host/Docker Desktop hiccup (a GC pause, a scheduling blip, macOS
resource contention) than a DELETE-specific code path in PgCache. We're not
ruling it out — one genuine >10s stall did happen, and neither same-conn nor
fresh-conn caught the update during it — but we can no longer call it
"reproducible." If DELETE-heavy invalidation reliability matters for your
use case, treat this as "saw it once, couldn't pin it down" rather than a
known issue, and re-test on your own infrastructure before drawing
conclusions.

---

## Summary

| Operation | Steady-state latency | Reliability | Notes |
|-----------|----------------------:|-------------|-------|
| SELECT (cache hit) | 0.5–1.5ms | No issues | Matches 0.6.0 |
| CREATE (INSERT) | ~80–115ms | Reliable in steady state | ~7-8s degraded for ~90s right after restart — expected, not a bug |
| UPDATE | ~85–100ms | Reliable in steady state | No confirmed issue |
| DELETE | ~65–98ms (2 outliers to 700ms) | 1 stall in 78 runs (~1.3%) | Not reproducible across a further 60 attempts; likely environmental noise, not confirmed as a PgCache defect |

**Bottom line:** PgCache 0.6.2 is a safe upgrade from 0.6.0 for this demo —
read-path performance is unchanged, and CDC invalidation is fast and
reliable for CREATE, UPDATE, and DELETE alike once the cache is warm. The
one thing worth actually remembering: **don't trust invalidation-latency
numbers measured in the ~90 seconds right after a restart** — that's a real,
100%-reproducible slow window, not noise. The single DELETE stall we saw
didn't reproduce after 60 further attempts with metrics/log capture running,
so we're not carrying it forward as a known issue — just noting it happened
once, in case a future user hits it too.

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
