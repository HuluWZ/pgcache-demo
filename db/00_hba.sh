#!/bin/bash
# Allow passwordless access from the Docker bridge network.
# PgCache's CDC worker connects for logical replication without sending a password.
# Logical replication connects to the actual database (not the "replication" keyword),
# so we grant trust for all databases from the Docker network range.
# Scope: 172.16.0.0/12 covers all Docker bridge subnets (172.17–172.31.x.x).
set -e

HBA="$PGDATA/pg_hba.conf"

# Insert before the catch-all scram-sha-256 rule so this rule wins first-match.
sed -i '/^host all all all scram-sha-256/i \
# PgCache (Docker network — trust avoids password auth for CDC replication worker)\
host    all             all             172.16.0.0/12           trust\
host    all             all             192.168.0.0/16          trust' "$HBA"

echo "pg_hba.conf patched — Docker-network trust rules inserted"
