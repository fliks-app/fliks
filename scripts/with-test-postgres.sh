#!/bin/sh
# Runs "$@" against a private PostgreSQL 18 container, removed on exit, so concurrent test runs never share databases.
set -eu
name="fliks-test-pg-$$"
docker run -d --rm --name "$name" -e POSTGRES_USER=fliks -e POSTGRES_PASSWORD=fliks -e POSTGRES_DB=fliks \
  -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql postgres:18 >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1' EXIT INT TERM
until docker exec "$name" pg_isready -h 127.0.0.1 -U fliks -q 2>/dev/null; do sleep 0.5; done
port=$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')
base="postgres://fliks:fliks@127.0.0.1:$port"
export DATABASE_URL="$base/fliks" S8_PG_ADMIN_URL="$base/postgres" FLIKS_HARNESS_PG_URL="$base/postgres" SQLX_OFFLINE=true
"$@"
