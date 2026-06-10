-- ============================================================
-- Schema
-- ============================================================

CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  username    TEXT NOT NULL,
  country     TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('free','pro','enterprise')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price_cents INT  NOT NULL,
  stock       INT  NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id          SERIAL PRIMARY KEY,
  user_id     INT  NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','cancelled')),
  total_cents INT  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id          SERIAL PRIMARY KEY,
  order_id    INT NOT NULL REFERENCES orders(id),
  product_id  INT NOT NULL REFERENCES products(id),
  quantity    INT NOT NULL,
  unit_price_cents INT NOT NULL
);

-- ============================================================
-- Replication setup for PgCache
-- ============================================================

-- PgCache needs REPLICATION privilege to create its logical replication slot.
ALTER ROLE demo REPLICATION;

-- Publication PgCache subscribes to via logical replication.
CREATE PUBLICATION pgcache_pub FOR ALL TABLES;

-- ============================================================
-- Seed data  (~16M rows total)
-- ============================================================

-- 1 000 000 users
INSERT INTO users (email, username, country, tier)
SELECT
  'user' || i || '@example.com',
  'user_' || i,
  (ARRAY['US','GB','DE','FR','JP','BR','IN','CA','AU','SG'])[1 + (i % 10)],
  (ARRAY['free','free','free','pro','pro','enterprise'])[1 + (i % 6)]
FROM generate_series(1, 1000000) AS i;

-- 2 000 products across 10 categories
INSERT INTO products (name, category, price_cents, stock)
SELECT
  'Product ' || i,
  (ARRAY['Electronics','Clothing','Books','Food','Sports',
         'Home','Beauty','Toys','Garden','Office'])[1 + (i % 10)],
  (100 + (random() * 49900)::int),
  (random() * 1000)::int
FROM generate_series(1, 2000) AS i;

-- 5 000 000 orders (in batches to avoid OOM)
INSERT INTO orders (user_id, status, total_cents, created_at)
SELECT
  1 + (random() * 999999)::int,
  (ARRAY['pending','paid','paid','shipped','shipped','cancelled'])[1 + (i % 6)],
  (500 + (random() * 99500)::int),
  now() - (random() * interval '730 days')
FROM generate_series(1, 5000000) AS i;

-- 10 000 000 order_items (avg 2 per order)
INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
SELECT
  1 + (random() * 4999999)::int,
  1 + (random() * 1999)::int,
  1 + (random() * 9)::int,
  (100 + (random() * 49900)::int)
FROM generate_series(1, 10000000) AS i;

-- ============================================================
-- Indexes  (make benchmark queries realistic)
-- ============================================================

CREATE INDEX idx_orders_user_id     ON orders(user_id);
CREATE INDEX idx_orders_status      ON orders(status);
CREATE INDEX idx_orders_created_at  ON orders(created_at);
CREATE INDEX idx_order_items_order  ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);
CREATE INDEX idx_users_country      ON users(country);
CREATE INDEX idx_users_tier         ON users(tier);
CREATE INDEX idx_products_category  ON products(category);

-- ============================================================
-- Verify row counts on startup (visible in docker logs)
-- ============================================================

DO $$
BEGIN
  RAISE NOTICE 'users: %',       (SELECT count(*) FROM users);
  RAISE NOTICE 'products: %',    (SELECT count(*) FROM products);
  RAISE NOTICE 'orders: %',      (SELECT count(*) FROM orders);
  RAISE NOTICE 'order_items: %', (SELECT count(*) FROM order_items);
END $$;
