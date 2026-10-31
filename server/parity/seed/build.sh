#!/usr/bin/env bash
# Rebuilds the fliks_parity_tpl template DB (server/migrations + deterministic rows) and dumps it to base.sql.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mig="$here/../../migrations"
probe="${FLIKS_ENGINE_FIXTURES:-$HOME/Documents/clement/code/fliks-engine/fixtures/probe}"
db=${PARITY_TPL:-fliks_parity_tpl}

# psql inside the container: credentials never leave it
sql() { docker exec -i "${PARITY_PG:-fliks-postgres-1}" sh -c 'PGOPTIONS="-c client_min_messages=warning" psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 -q "$@"' _ "$@"; }

sql -d postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db"
for f in "$mig"/*.sql; do sql -d $db <"$f"; done

# sqlx ledger, so fliks-server finds the schema already migrated
{
  echo 'CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL);'
  for f in "$mig"/*.sql; do
    b=$(basename "$f" .sql)
    echo "INSERT INTO _sqlx_migrations VALUES (${b%%_*}, '$(echo "${b#*_}" | tr _ ' ')', '2026-01-01', true, '\\x$(sha384sum "$f" | cut -d' ' -f1)', 0);"
  done
} | sql -d $db

# Hashes of "<username>-pass", bcrypt cost 10, generated once.
H_ADMIN='$2b$10$mrdWC15ycA2Rj3R4TkCrmOjREitArik5RyYlTj321tduIJEg6L3j.'
H_USER='$2b$10$eruz5MPbynE0zGJakNz.Megq1Chq0fpuEs3fxZjRiqKstt50S3WjK'
H_READONLY='$2b$10$.yaNcwA9gwTu4YyRScgESeSOn1XxH53H8H41ix4KFH0IQg1Lr5Of.'
H_OTHER='$2b$10$NELnurd6YNZvN22qu743I.4Hbhm3lp8C2E2fPV8X2M2NII1434f2y'
H_MANAGER='$2b$10$Ut70hjOYdk4JkkYE2.atA.RDi56Nkj1YW6RUYwjPu3bafFozSqCX6'

{
cat <<SQL
INSERT INTO roles (id, name, permissions, "isDefault") VALUES
 (1, 'Admin', '["media.read","media.create","media.edit","media.delete","media.grab","livetv.read","requests.create","requests.manage","subtitles.manage","settings.access","users.manage","roles.manage"]', false),
 (2, 'User', '["media.read","livetv.read","requests.create"]', true),
 (3, 'Readonly', '["media.read","livetv.read"]', false),
 (4, 'Manager', '["media.read","users.manage"]', false);
INSERT INTO users (id, username, email, "passwordHash", "roleId", "isAdmin", avatar) VALUES
 (1, 'admin', 'admin@parity.test', '$H_ADMIN', NULL, true, NULL),
 (2, 'user', 'user@parity.test', '$H_USER', 2, false, NULL),
 (3, 'readonly', 'readonly@parity.test', '$H_READONLY', 3, false, NULL),
 (4, 'other', 'other@parity.test', '$H_OTHER', 2, false, '/api/users/4/avatar?v=1767225600000'),
 (5, 'manager', 'manager@parity.test', '$H_MANAGER', 4, false, NULL);
INSERT INTO libraries (id, name, icon, color, "mediaTypes", path) VALUES
 (1, 'Movies', 'film', '#3b82f6', '["movie"]', '/tmp/fliks-parity/media/movies'),
 (2, 'Series', 'tv', '#10b981', '["series"]', '/tmp/fliks-parity/media/series');
INSERT INTO library_user_access ("libraryId", "userId") VALUES (1,2),(2,2),(1,3),(1,4),(2,4),(1,5),(2,5);
INSERT INTO role_default_libraries ("roleId", "libraryId") VALUES (2,1),(2,2);
INSERT INTO app_settings (key, value) VALUES ('parity_flag', 'on'), ('parity_json', '{"a":1}'), ('parity_null', NULL);
SQL
python3 - "$probe" <<'PY'
import json, sys
probe = sys.argv[1]
def fx(name):
    d = json.load(open(f"{probe}/{name}.json"))
    return json.dumps(d["expected"]["info"], sort_keys=True).replace("'", "''"), d["fileSize"]
info = {"mkv": fx("h264-aac-mkv"), "mp4": fx("h264-aac-mp4")}
q = lambda s: "'" + s.replace("'", "''") + "'"
media, ext_ids, files, seasons, episodes = [], [], [], [], []
fid = 0
for n in range(1, 18):
    title = f"Parity Movie {n:02d}"
    folder = f"{title} (2020)"
    ext_ids.append(f"('media', {n}, 'movie', 'tmdb', '{1000+n}')")
    media.append(f"({n}, {q(title)}, 2020, 'movie', {q('Synthetic movie '+str(n))}, 'released', true, {q(folder)}, 7.5, '[\"Drama\"]', 90, '2020-01-01', 1)")
    ext = "mp4" if n % 2 == 0 else "mkv"
    fid += 1
    i, size = info[ext]
    files.append(f"({fid}, {n}, NULL, {q(folder+'.'+ext)}, {size}, 'WEBDL-1080p', 'en', '{i}')")
sid = eid = 0
for k, s in enumerate("ABC"):
    mid = 18 + k
    title = f"Parity Series {s}"
    ext_ids.append(f"('media', {mid}, 'series', 'tmdb', '{2000+k}')")
    media.append(f"({mid}, {q(title)}, 2021, 'series', {q('Synthetic series '+s)}, 'continuing', true, {q(title)}, 8.0, '[\"Drama\"]', 30, NULL, 2)")
    for se in (1, 2):
        sid += 1
        seasons.append(f"({sid}, {se}, {mid})")
        for ep in (1, 2):
            eid += 1; fid += 1
            episodes.append(f"({eid}, {ep}, {q(f'Episode {ep}')}, true, {sid})")
            i, size = info["mkv"]
            files.append(f"({fid}, {mid}, {eid}, {q(f'Season {se:02d}/{title} - S{se:02d}E{ep:02d}.mkv')}, {size}, 'WEBDL-1080p', 'en', '{i}')")
print('INSERT INTO media (id, title, year, type, overview, status, monitored, "folderName", rating, genres, runtime, "releaseDate", "libraryId") VALUES\n ' + ",\n ".join(media) + ";")
print('INSERT INTO external_ids (entity, "entityId", scope, provider, value) VALUES\n ' + ",\n ".join(ext_ids) + ";")
print('INSERT INTO seasons (id, "seasonNumber", "mediaId") VALUES\n ' + ",\n ".join(seasons) + ";")
print('INSERT INTO episodes (id, "episodeNumber", title, "hasFile", "seasonId") VALUES\n ' + ",\n ".join(episodes) + ";")
print('INSERT INTO media_files (id, "mediaId", "episodeId", "relativePath", size, quality, language, "streamInfo") VALUES\n ' + ",\n ".join(files) + ";")
PY
cat <<'SQL'
INSERT INTO requests (id, "mediaType", "tmdbId", title, status, "userId", "libraryId") VALUES
 (1, 'movie', 9001, 'Requested Movie', 'pending', 2, 1),
 (2, 'series', 9002, 'Requested Series', 'approved', 4, 2);
INSERT INTO playlists (id, name, "ownerId", visibility) VALUES (1, 'Parity Playlist', 2, 'private');
INSERT INTO playlist_items ("playlistId", "mediaId", position, "addedById") VALUES (1,1,0,2),(1,2,1,2),(1,3,2,2);
INSERT INTO likes ("userId", "mediaId") VALUES (2,1),(2,18),(4,2);
INSERT INTO playback_states ("positionSeconds", "durationSeconds", completed, "lastPlayedAt", "playedAt", "userId", "mediaId", "mediaFileId", "episodeId") VALUES
 (1200, 3600, false, '2026-01-02', NULL, 2, 1, 1, NULL),
 (3500, 3600, true, '2026-01-03', '2026-01-03', 2, 2, 2, NULL),
 (600, 1800, false, '2026-01-04', NULL, 2, 18, 18, 1),
 (300, 3600, false, '2026-01-02', NULL, 3, 1, 1, NULL);
-- fixed timestamps and sequences past the explicit ids
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.table_name t FROM information_schema.columns c JOIN information_schema.tables x USING (table_schema, table_name)
           WHERE c.table_schema = 'public' AND c.column_name = 'updatedAt' AND x.table_type = 'BASE TABLE' LOOP
    EXECUTE format('UPDATE %I SET "createdAt" = %L, "updatedAt" = %L', r.t, '2026-01-01', '2026-01-01');
  END LOOP;
  FOR r IN SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT max(id) FROM %I), 1), (SELECT count(*) > 0 FROM %I))', r.t, r.t, r.t);
  END LOOP;
END $$;
SQL
} | sql -d $db

docker exec "${PARITY_PG:-fliks-postgres-1}" sh -c 'pg_dump -U "$POSTGRES_USER" --no-owner --no-privileges '"$db" |
  grep -v '^\\\(un\)\?restrict ' >"$here/base.sql"
echo "wrote $here/base.sql"
