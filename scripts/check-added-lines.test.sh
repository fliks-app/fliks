#!/usr/bin/env bash
# Self-test of check-added-lines.sh: each case is one added line of a file; `bad` must fail, `ok` pass.
cd "$(dirname "$0")" || exit 1
n=0
case_() {
  local want=$1 file=$2 line=$3 got=0
  printf '+++ b/%s\n+%s\n' "$file" "$line" | ./check-added-lines.sh >/dev/null || got=1
  [[ $want == bad && $got == 1 || $want == ok && $got == 0 ]] || { echo "FAIL ($want): $file: $line"; n=1; }
}
case_ bad server/crates/server/src/a.rs "let id = \"fliks.tmdb\";"
case_ bad client/src/app/a.ts "const id = 'fliks.tmdb';"
case_ ok client/src/app/tab-nonce.ts "const KEY = 'fliks.tab';"
case_ ok client/src/app/tizen-engine.ts "const KEY = 'fliks.avtest';"
case_ ok client/src/app/a.spec.ts "const id = 'fliks.tmdb';"
case_ bad client/src/app/a.html "<p class=\"text-xs\">x</p>"
case_ ok client/src/app/a.html "<p class=\"text-sm\">x</p>"
case_ bad client/src/app/a.ts "try { a(); } catch {}"
S=server/crates/server/src
case_ bad $S/a.rs 'sqlx::query("select v from app_settings")'
case_ bad $S/a.rs 'sqlx::query("SELECT v FROM App_Settings")'
case_ bad $S/a.rs 'sqlx::query(r#"select v from "app_settings""#)'
case_ bad $S/a.rs 'sqlx::query("select v from public.app_settings")'
case_ ok $S/settings/a.rs 'sqlx::query("select v from app_settings")'
case_ ok $S/a.rs 'let t = "app_settings_audit";'
case_ bad $S/a.rs 'h.get("X-Forwarded-For")'
case_ bad $S/a.rs 'h.get("x-real-ip")'
case_ bad $S/a.rs 'h.get("Forwarded")'
case_ ok $S/http/a.rs 'h.get("x-forwarded-for")'
case_ ok $S/a.rs 'let forwarded_count = 1;'
exit $n
