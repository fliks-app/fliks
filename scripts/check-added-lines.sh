#!/usr/bin/env bash
# Reads a `git diff -U0` on stdin; fails on added lines matching a banned shape.
exec awk -v q=\' -v d="$(printf '\342\200\224')" '
/^\+\+\+ /{f=substr($2,3); next}
!/^\+/{next}
function bad(why){print f": "why": "$0; fail=1}
index($0,d){bad("literal em dash")}
f ~ /\.rs$/ {
  if ($0 ~ /Lagged\(_\)\)? *=> *\{\}/) bad("silent lag arm")
  if ($0 ~ /let _ = sqlx::/) bad("discarded sqlx result")
  if ($0 ~ /unwrap_or\(Value::Null\)/) bad("unwrap_or(Value::Null)")
}
f ~ /^client\/src\/.*\.ts$/ && $0 ~ /catch *(\{ *\}|\{ *\/\* *interceptor *\*\/ *\})/ {bad("silent catch")}
f ~ /^client\/src\// {
  if ($0 ~ /(^|[^A-Za-z0-9_-])text-xs([^A-Za-z0-9_-]|$)/ || $0 ~ /text-\[(0\.[0-7][0-9]*rem|1[0-3]px|[0-9]px)\]/) bad("font size below text-sm")
  if ($0 ~ /text-base-content\/(30|40)/ && $0 !~ /<svg|lucide|app-nav-icon/) bad("muted text contrast")
}
f ~ /^(server\/crates\/[^\/]+\/src|client\/src)\// && f !~ /(\/tests?\/|fixtures?|\.spec\.|\.test\.|_tests?\.rs$|\/tests?\.rs$)/ {
  if (($0 ~ ("[" q "\"]fliks\\.[a-z][a-z0-9]*[" q "\"]") && $0 !~ ("[" q "\"]fliks\\.(tab|avtest)[" q "\"]")) || $0 ~ /fliks-[a-z0-9]+\.(settings|nav)\./) bad("plugin id in core")
}
END{exit fail}'
