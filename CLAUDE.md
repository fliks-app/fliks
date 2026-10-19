# Fliks

## Comments

- Keep them short and rare. Comment only what the code can't say: a non-obvious constraint, a why.
- No verbose block comments, no restating the next line, no narrating a past bug — that belongs in the commit message.

## Engine

- The video/streaming engine lives in github.com/fliks-app/engine; its protocol is that repo's `PROTOCOL.md`.
- Background media jobs (sprites, keyframe scan, intro fingerprint, subtitle extraction) are engine jobs, run through the engine client in `server/crates/server/src/engine/`.
- Bump it with `scripts/bump-engine.sh <version>`, which rewrites `engine.lock` (version + sha256 per platform, for the desktop bundles), the `ENGINE_IMAGE` default in the `Dockerfile` (`ghcr.io/fliks-app/engine:<version>@sha256:<digest>`) and the `fliks-engine-core` tag of `server/crates/server/Cargo.toml` (and both `Cargo.lock`); `engine-lock.yml` fails a PR where they disagree.
- The image is built `FROM` the engine image (`ARG ENGINE_IMAGE`): ffmpeg, mkvmerge, fpcalc, OpenCL and the `fliks-engine` binary are defined in the engine repo, not here. Test an unreleased engine with `--build-arg ENGINE_IMAGE=ghcr.io/fliks-app/engine:main` (or the `engine_image` input of the publish workflow).
- The dev stack (`docker-compose.dev.example.yml`) mirrors production: the engine (`../fliks-engine`, cargo watch) is the front door on :3000 and forwards to `server` (`fliks-server`, cargo watch on `server/`, :3001), the whole HTTP API. Run `scripts/bump-engine.sh --local ../fliks-engine` to build the server against a local engine checkout.

### Dev database re-baseline

Dev DBs built by TypeORM `synchronize` have an empty migrations ledger and `fliks-server migrate` refuses them. Once per dev DB, from the repo root (`dc` = `docker compose -f docker-compose.yml`):

```bash
dc stop server
dc exec -T postgres sh -c 'pg_dump -U $POSTGRES_USER -Fc -T migrations $POSTGRES_DB' > .dev/fliks.dump
dc exec postgres sh -c 'dropdb -U $POSTGRES_USER $POSTGRES_DB && createdb -U $POSTGRES_USER $POSTGRES_DB'
dc run --rm server cargo run -p fliks-server -- migrate
echo "SELECT 'TRUNCATE ' || string_agg(format('%I', tablename), ',') || ' CASCADE' FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_sqlx_migrations' \gexec" | dc exec -T postgres sh -c 'psql -U $POSTGRES_USER $POSTGRES_DB'
dc exec -T postgres sh -c 'pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --data-only --disable-triggers -n public' < .dev/fliks.dump
dc exec -T postgres sh -c 'pg_restore -U $POSTGRES_USER -d $POSTGRES_DB -N public' < .dev/fliks.dump  # plugin schemas, schema + data
dc up -d
```

The `TRUNCATE` clears rows seeded by migrations (e.g. `plugin_sources`). Expect `pg_restore` errors only for tables dropped by later migrations (e.g. `delay_profiles`) and their sequences, plus `migrations_id_seq`.

## Angular conventions

- Always use external template files (`templateUrl`) instead of inline templates (`template`) in components.
- Never hardcode user-facing strings. Use `TranslateService` (ngx-translate) for all text, including toast messages (e.g. `this.toast.success(this.translate.instant('key'))` not `this.toast.success('Settings saved')`).

## Git workflow

- **`main` is protected**: direct pushes are rejected (`protected branch hook declined`). Every change has to land via a pull request — branch off `main`, push the branch, open the PR, then merge through GitHub (`gh pr merge`).
- **Don't run `git push` against `main` directly**; it always fails. If you mistakenly committed straight to local `main`, move the commit onto a branch (`git checkout -b <branch>` while on the commit, then `git reset --hard origin/main` on `main`) before pushing.
- **Squash-merge to escape a bad-message branch**: when an existing branch's history has commits that fail `commitlint` or `release-parser` (both check every commit in the PR, see Commit conventions), prefer `gh pr merge --squash` with a clean conventional title over rewriting + force-pushing. Force-push to a published branch is destructive and needs explicit user approval.
- **Never merge `main` into a PR branch**: the merge commit (`Merge remote-tracking branch 'origin/main' into …`) is not a conventional commit and fails `release-parser`. Bring a branch up to date by rebasing onto `origin/main` before its first push; once it is published, catching up means a rebase and a force-push, which needs explicit user approval.
- **Local hooks**: see `.husky/` if present. Don't bypass them.
- **Write pull requests in English** — title and body — like commit messages and code comments, whatever language the conversation uses.

## Commit conventions

Two jobs in `.github/workflows/commit-lint.yml` check every commit of a PR, then the squash commit once it lands on `main`:

- `commitlint`: `wagoid/commitlint-github-action` with `@commitlint/config-conventional` defaults.
- `release-parser`: release-please's own, stricter parser (`.github/scripts/check-commit-parse.mjs`). release-please silently drops a message it can't parse from the changelog and the version bump. It rejects merge commits and an unbalanced `(` in the body.

Neither is a required status check (GitHub still lets a PR merge with them red), so treat a red job as blocking. **Always apply these rules**:

- **Header format**: `type(scope): subject` — type and scope lowercase, scope optional but encouraged.
- **Allowed types**: `feat`, `fix`, `chore`, `refactor`, `style`, `docs`, `test`, `perf`, `build`, `ci`, `revert`.
- **Subject case**: lowercase first word. Not sentence-case (`Add foo`), start-case (`Add Foo`), pascal-case (`AddFoo`), or upper-case (`ADD FOO`). Proper nouns and acronyms inside the subject are fine (`fix(player): patch HEVC remux`). When the natural subject would start with a capitalised proper noun, rephrase to avoid it (e.g. write `add show-more toggle on the mobile synopsis` not `Voir plus toggle on mobile synopsis`).
- **Subject ending**: no trailing period.
- **Header length**: keep ≤ 72 characters when possible; the limit is 100.
- **Body**: separate from the header with one blank line. Explain *why*, not *what*. Wrap each line at ≤ 100 characters. Keep every `(` closed: `release-parser` rejects an unbalanced one. Reference incidents, constraints, or prior bugs that motivated the change.
- **Squash-merge messages are linted too, after the fact**: the `commit_message` passed to a squash merge (`gh api .../merge -f commit_message=...`) becomes a commit on `main`, linted on push, with no way to fix it once merged (#1570 shipped a 139-character body line). Hard-wrap every line of it at ≤ 100 characters, like any commit body, and check `awk '{print length}'` before merging.
- **Footer**: blank line before, used for issue refs (`Refs: #123`) or `BREAKING CHANGE:` notes.
- **No `Co-Authored-By` lines** (overrides the default Claude Code template — see the user's global instructions).
- **Don't skip hooks** (`--no-verify`, `--no-gpg-sign`) unless explicitly asked.

Examples that pass:
```
feat(media-detail): add show-more toggle on the mobile synopsis
fix(spatial-nav): trap focus inside open dropdowns and selects
refactor(spatial-nav): unify sidebar traversal by relaxing scroller scope
chore(app-settings): redirect /app-settings to /display
```

Examples that fail and how to fix:
- `feat(media-detail): Voir plus / Voir moins toggle…` → subject starts upper-case. Rewrite as `add show-more toggle…`.
- `fix: Removed unused import.` → starts upper-case AND ends with a period. Rewrite as `fix: remove unused import`.
- `Update foo` → no type. Pick one (`chore: update foo`).
