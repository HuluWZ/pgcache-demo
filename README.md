# PgCache Demo

A reproducible benchmark of [PgCache](https://www.pgcache.com) — a transparent
read-through cache that speaks the PostgreSQL wire protocol and keeps cached
results fresh with Change Data Capture (CDC) over logical replication.

The demo stands up a 16M-row Postgres database behind PgCache, then measures the
same queries run two ways: directly against the origin, and through the proxy
with a warm cache. It also measures how fast a write to the origin propagates to
the cache.

## Architecture

```text
                          app/ (TypeScript: benchmark.ts, cdc-demo.ts)
                                          │
                    proxy :5432           │           origin :5433
                  (cached reads)          │       (direct, for comparison)
                          ┌───────────────┴───────────────┐
                          ▼                                ▼
                  ┌───────────────┐              ┌──────────────────┐
                  │   PgCache     │              │                  │
                  │   proxy       │              │   Postgres 17    │
                  │   :5432       │              │   origin         │
                  │   :9090 mtrx  │              │                  │
                  └───────┬───────┘              └─────────┬────────┘
                          │   SELECT passthrough + writes  │
                          │ ──────────────────────────────▶│
                          │   logical replication (CDC)     │
                          │ ◀── pgcache_pub / pgcache_slot ─│
                          └────────────────────────────────┘
```

- Cacheable `SELECT`s are served from PgCache's local cache after the first run.
- `INSERT` / `UPDATE` / `DELETE` and DDL pass straight through to the origin.
- The origin streams every change to PgCache over a logical replication slot, so
  the cache stays consistent without manual invalidation.

## Prerequisites

- Docker (with Compose v2)
- Node.js 18+
- About 6 GB of free RAM. PgCache mmaps its cache into `/dev/shm`; the compose
  file requests a 4 GB shm for the proxy.

The default image tag targets Apple Silicon (`-arm64`). On Intel/AMD hosts, set
`PGCACHE_IMAGE` to the `-amd64` tag in your `.env` (see below).

## Quick start

```bash
# 1. Configure
cp .env.example .env        # adjust ports, credentials, or image tag if needed

# 2. Bring up Postgres + PgCache
docker compose up -d

# 3. Wait for the seed to finish (~16M rows). Watch for the row-count notices:
docker compose logs -f postgres
#   ... NOTICE: users: 1000000 / orders: 5000000 / order_items: 10000000

# 4. Install the benchmark app
cd app && npm install

# 5. Run
npm run cdc-demo     # measure cache invalidation latency
npm run benchmark    # measure origin vs cached query latency
```

The first `docker compose up` runs the full seed in `db/init.sql`, which takes a
few minutes. Subsequent starts reuse the `postgres_data` volume and are instant.

## What gets measured

`app/src/queries.ts` defines four queries spanning the range where a cache helps
least to most:

| Query | Shape | Why it's here |
|-------|-------|---------------|
| `point_lookup` | `SELECT … WHERE id = $1` over a 10-ID pool | Already fast on the origin; shows the cache adds little for trivial lookups |
| `tier_aggregate` | `GROUP BY tier` over 1M users | Mid-weight aggregate |
| `revenue_by_country` | 5M-row `JOIN` of orders to users, summed | Heavy join + aggregate |
| `top_products` | `JOIN` order_items to products, ranked per category | Heaviest scan in the set |

The benchmark warms the proxy cache, then runs each query 150 times at
concurrency 10 against both targets and reports p50/p95/p99.

## Results

Measured locally on PgCache `0.6.0-arm64`, Postgres 17, dataset of 1M users /
2K products / 5M orders / 10M order_items. Full machine-readable output is in
[app/results.json](app/results.json).

| Query | Origin p50 | Proxy p50 | Speedup p50 | Origin p99 | Proxy p99 | Speedup p99 |
|-------|-----------:|----------:|------------:|-----------:|----------:|------------:|
| `point_lookup` | 0.5 ms | 0.4 ms | 1.4x | 4.2 ms | 3.4 ms | 1.3x |
| `tier_aggregate` | 150 ms | 0.5 ms | 302x | 194 ms | 1.0 ms | 200x |
| `revenue_by_country` | 1252 ms | 0.5 ms | 2356x | 1648 ms | 2.3 ms | 724x |
| `top_products` | 2703 ms | 0.6 ms | 4434x | 3107 ms | 1.3 ms | 2318x |

The cache earns its keep on expensive aggregates and joins. For `point_lookup`,
the origin is already sub-millisecond, so routing through the proxy adds a hop
without a meaningful win — that row is included precisely to show where caching
does *not* pay off.

## CDC invalidation

`npm run cdc-demo` warms an aggregate in the cache, writes a new row **directly
to the origin** (bypassing the proxy), then polls the proxy until the cached
result reflects the change:

```text
Cached count (enterprise users via proxy): 166,666
Inserted directly to origin: cdc_demo_...@test.com
Propagated in ≤94ms
Count before: 166,666
Count after:  166,667 (+1)
```

Propagation is consistently under ~100 ms on this setup. PgCache keeps the cached
aggregate correct under all write paths — including `DELETE`s issued through the
proxy — on 0.6.0. (An earlier 0.5.0 build left proxy-side `DELETE`s stale on
cached aggregates; 0.6.0 is required.)

## Configuration

Both `docker-compose.yml` and the app read from a single repo-root `.env`
(copied from [.env.example](.env.example)):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PGCACHE_IMAGE` | `pgcache/pgcache:0.6.0-arm64` | Proxy image/tag (use `-amd64` on Intel/AMD) |
| `PGCACHE_SHM_SIZE` | `4gb` | `/dev/shm` for the proxy; must exceed 2x its shared_buffers |
| `PGCACHE_TELEMETRY` | `off` | Anonymous usage telemetry (`off` for clean benchmarking) |
| `PGCACHE_PINNED_QUERIES` | the 3 aggregates | Semicolon-separated queries warmed at startup; empty disables |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `demo` / `demo` / `demodb` | Origin credentials |
| `PROXY_PORT` | `5432` | Host port for the PgCache proxy |
| `ORIGIN_PORT` | `5433` | Host port for the origin Postgres |
| `METRICS_PORT` | `9090` | Host port for PgCache Prometheus metrics |
| `PGHOST` | `localhost` | Host the app dials for both pools |

## Operational notes

- **shm sizing.** PgCache refuses to start if `/dev/shm` is not larger than twice
  its shared_buffers, hence the 4 GB request. The error names a size, but the
  check is strict-greater — set it comfortably above the stated minimum.
- **Replication.** `db/init.sql` grants the origin role `REPLICATION` and creates
  the `pgcache_pub` publication; `db/00_hba.sh` adds Docker-network `trust` rules
  so the CDC worker can connect for logical replication.
- **Cache after restart.** A restart starts with a cold cache and repopulates
  from the origin; it never serves stale data. The replication slot persists on
  the origin if PgCache stops ungracefully — drop `pgcache_slot` manually if you
  tear the proxy down for good.
- **Startup warming.** The three aggregate queries are listed in
  `PGCACHE_PINNED_QUERIES`, so PgCache validates and populates them at startup;
  the first client query of those shapes is already a cache hit. Clear the
  variable to disable. The parameterized `point_lookup` is not pinnable.
- **Telemetry.** PgCache sends anonymous usage telemetry by default; this demo
  sets `PGCACHE_TELEMETRY=off` for clean, reproducible runs.

## Project layout

```text
.
├── docker-compose.yml     # Postgres 17 origin + PgCache proxy
├── .env.example           # configuration template
├── db/
│   ├── init.sql           # schema, seed (~16M rows), indexes, publication
│   └── 00_hba.sh          # pg_hba.conf trust rules for the CDC worker
├── app/
│   └── src/
│       ├── queries.ts     # the four benchmark queries + connection pools
│       ├── benchmark.ts   # origin vs proxy latency, writes results.json
│       └── cdc-demo.ts    # invalidation-latency demo
└── Makefile               # up / down / reset / logs / psql / metrics helpers
```

## Makefile helpers

```text
make up           # docker compose up -d
make down         # docker compose down
make reset        # down -v + up (wipes the data volume, re-seeds)
make psql-proxy   # psql into the PgCache proxy (:5432)
make psql-origin  # psql into the origin Postgres (:5433)
make metrics      # curl PgCache Prometheus metrics
make hitrate      # cache hit/miss counters
```
