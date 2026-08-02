# Fliks

## Comments

- Keep them short and rare. Comment only what the code can't say: a non-obvious constraint, a why.
- No verbose block comments, no restating the next line, no narrating a past bug — that belongs in the commit message.

## Angular conventions

- Always use external template files (`templateUrl`) instead of inline templates (`template`) in components.
- Never hardcode user-facing strings. Use `TranslateService` (ngx-translate) for all text, including toast messages (e.g. `this.toast.success(this.translate.instant('key'))` not `this.toast.success('Settings saved')`).

## Git workflow

- **`main` is protected**: direct pushes are rejected (`protected branch hook declined`). Every change has to land via a pull request — branch off `main`, push the branch, open the PR, then merge through GitHub (`gh pr merge`).
- **Don't run `git push` against `main` directly**; it always fails. If you mistakenly committed straight to local `main`, move the commit onto a branch (`git checkout -b <branch>` while on the commit, then `git reset --hard origin/main` on `main`) before pushing.
- **Squash-merge to escape a bad-message branch**: when an existing branch's history has commits that fail commitlint (the lint runs on every commit in the PR), prefer `gh pr merge --squash` with a clean conventional title over rewriting + force-pushing. Force-push to a published branch is destructive and needs explicit user approval.
- **Local hooks**: see `.husky/` if present. Don't bypass them.
- **Write pull requests in English** — title and body — like commit messages and code comments, whatever language the conversation uses.

## Commit conventions

Enforced by `wagoid/commitlint-github-action` on every PR and push to `main` (see `.github/workflows/commit-lint.yml`) using `@commitlint/config-conventional` defaults. A failing lint blocks the merge. **Always apply these rules**:

- **Header format**: `type(scope): subject` — type and scope lowercase, scope optional but encouraged.
- **Allowed types**: `feat`, `fix`, `chore`, `refactor`, `style`, `docs`, `test`, `perf`, `build`, `ci`, `revert`.
- **Subject case**: lowercase first word. Not sentence-case (`Add foo`), start-case (`Add Foo`), pascal-case (`AddFoo`), or upper-case (`ADD FOO`). Proper nouns and acronyms inside the subject are fine (`fix(player): patch HEVC remux`). When the natural subject would start with a capitalised proper noun, rephrase to avoid it (e.g. write `add show-more toggle on the mobile synopsis` not `Voir plus toggle on mobile synopsis`).
- **Subject ending**: no trailing period.
- **Header length**: keep ≤ 72 characters when possible; the limit is 100.
- **Body**: separate from the header with one blank line. Explain *why*, not *what*. Wrap each line at ≤ 100 characters. Reference incidents, constraints, or prior bugs that motivated the change.
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
