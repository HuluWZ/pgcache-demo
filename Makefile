.PHONY: up down reset logs ps psql-origin psql-proxy

up:
	docker compose up -d

down:
	docker compose down

reset:
	docker compose down -v
	docker compose up -d

logs:
	docker compose logs -f

ps:
	docker compose ps

# Connect directly to the origin PostgreSQL (port 5433)
psql-origin:
	PGPASSWORD=demo psql -h localhost -p 5433 -U demo -d demodb

# Connect through PgCache proxy (port 5432)
psql-proxy:
	PGPASSWORD=demo psql -h localhost -p 5432 -U demo -d demodb

# Show Prometheus metrics from PgCache
metrics:
	curl -s http://localhost:9090/metrics | grep -E '^pgcache_'

# Cache hit/miss ratio
hitrate:
	curl -s http://localhost:9090/metrics | grep -E 'pgcache_queries'
