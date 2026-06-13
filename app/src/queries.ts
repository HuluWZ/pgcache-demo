import { Pool, PoolClient } from "pg";
import * as path from "path";
import * as dotenv from "dotenv";

// One source of truth: the repo-root .env that docker-compose also reads.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const PGHOST = process.env.PGHOST ?? "localhost";
export const ORIGIN_PORT = parseInt(process.env.ORIGIN_PORT ?? "5433", 10);
export const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? "5432", 10);

export interface Query {
  name: string;
  description: string;
  run: (client: PoolClient) => Promise<void>;
}

// Q1: Point lookup — small fixed pool of IDs so the cache actually hits them repeatedly
const LOOKUP_IDS = [1, 1001, 5000, 12345, 50000, 99999, 200000, 500000, 750000, 999999];
export const pointLookup: Query = {
  name: "point_lookup",
  description: "SELECT user by ID (10-ID pool, tests repeated cache hits)",
  run: async (client) => {
    const id = LOOKUP_IDS[Math.floor(Math.random() * LOOKUP_IDS.length)];
    await client.query("SELECT id, email, username, country, tier FROM users WHERE id = $1", [id]);
  },
};

// Q2: Aggregate — GROUP BY over 1M users; PgCache materializes this and keeps it fresh via CDC
export const userTierAggregate: Query = {
  name: "tier_aggregate",
  description: "COUNT users grouped by tier (aggregate over 1M rows)",
  run: async (client) => {
    await client.query(`
      SELECT tier, count(*) AS total, count(*) FILTER (WHERE country = 'US') AS us_count
      FROM users
      GROUP BY tier
      ORDER BY tier
    `);
  },
};

// Q3: Heavy JOIN + aggregate — joins 5M orders to 1M users, sums revenue by country
// This is the headline query: slow on origin cold, fast via cache
export const revenueByCountry: Query = {
  name: "revenue_by_country",
  description: "SUM revenue joined across users + orders (5M row JOIN)",
  run: async (client) => {
    await client.query(`
      SELECT u.country,
             count(o.id)          AS order_count,
             sum(o.total_cents)   AS revenue_cents
      FROM users u
      JOIN orders o ON u.id = o.user_id
      WHERE o.status = 'shipped'
      GROUP BY u.country
      ORDER BY revenue_cents DESC
    `);
  },
};

// Q4: Filtered aggregate with range — tests predicate subsumption
// (once the full aggregate is cached, narrower predicates are served from it)
export const topProductsByCategory: Query = {
  name: "top_products",
  description: "Top products by order volume per category (JOIN order_items → products)",
  run: async (client) => {
    await client.query(`
      SELECT p.category,
             p.name,
             sum(oi.quantity) AS units_sold
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      GROUP BY p.category, p.id, p.name
      ORDER BY p.category, units_sold DESC
      LIMIT 40
    `);
  },
};

export const ALL_QUERIES: Query[] = [
  pointLookup,
  userTierAggregate,
  revenueByCountry,
  topProductsByCategory,
];

export function makePool(host: string, port: number): Pool {
  return new Pool({
    host,
    port,
    user: process.env.POSTGRES_USER ?? "demo",
    password: process.env.POSTGRES_PASSWORD ?? "demo",
    database: process.env.POSTGRES_DB ?? "demodb",
    max: 50,
  });
}

export const makeOriginPool = (): Pool => makePool(PGHOST, ORIGIN_PORT);
export const makeProxyPool = (): Pool => makePool(PGHOST, PROXY_PORT);
