#!/bin/sh
# Runs "$@" against a private PostgreSQL container (18, or FLIKS_TEST_PG_VERSION), removed on exit, so concurrent test runs never share databases.
# FLIKS_TEST_APP_ROLE=1 runs the tests as the non-superuser `fliks_app` (FLIKS_SERVER_BIN: a built fliks-server, else cargo run).
set -eu
name="fliks-test-pg-$$"
docker run -d --rm --name "$name" -e POSTGRES_USER=fliks -e POSTGRES_PASSWORD=fliks -e POSTGRES_DB=fliks \
  -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql "postgres:${FLIKS_TEST_PG_VERSION:-18}" >/dev/null
data=$(mktemp -d)
trap 'docker rm -f "$name" >/dev/null 2>&1; rm -rf "$data"' EXIT INT TERM
until docker exec "$name" pg_isready -h 127.0.0.1 -U fliks -q 2>/dev/null; do sleep 0.5; done
port=$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')
base="postgres://fliks:fliks@127.0.0.1:$port"
url="$base/fliks"
if [ "${FLIKS_TEST_APP_ROLE:-0}" = 1 ]; then
  server=${FLIKS_SERVER_BIN:-"cargo run -q --manifest-path $(dirname "$0")/../server/Cargo.toml -p fliks-server --"}
  app_pw=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
  db_role() {
    DB_HOST=127.0.0.1 DB_PORT=$port DB_NAME=$1 DB_USERNAME=fliks_app DB_PASSWORD=$app_pw DB_ADMIN_USERNAME=fliks DB_ADMIN_PASSWORD=fliks \
      SQLX_OFFLINE=true $server db-role
  }
  db_role template1
  db_role fliks
  # Test-only: sqlx::test creates a database per test. Those are app-owned, so this run does not prove the database-level CREATE grant: db_role.rs does.
  docker exec "$name" psql -U fliks -d postgres -v ON_ERROR_STOP=1 -q -c 'ALTER ROLE fliks_app CREATEDB'
  url="postgres://fliks_app:$app_pw@127.0.0.1:$port/fliks"
  migrate_url="postgres://fliks_app:$app_pw@127.0.0.1:$port/template1"
else
  migrate_url="$base/template1"
fi
# Every test database is a copy of template1: migrating it once spares each test the replay. Nothing may connect to it afterwards.
sqlx migrate run --source "$(dirname "$0")/../server/migrations" --database-url "$migrate_url" >/dev/null
export DATABASE_URL="$url" S8_PG_ADMIN_URL="$base/postgres" FLIKS_HARNESS_PG_URL="$base/postgres" SQLX_OFFLINE=true FLIKS_DATA_DIR="$data"
"$@"
