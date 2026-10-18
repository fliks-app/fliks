# Golden vectors

Each `<set>/cases.json` holds inputs and expected outputs generated from the Nest code, frozen since Nest's
removal. The TypeScript harnesses that generated them stay readable at the git tag `nest-final`
(`git show nest-final:<harness path>`, the path is in the set's spec); a set whose harness left earlier
names its source commit in its spec's Vectors section. `playback-info/engine-playback.recorded.json` is
recorded from the engine instead.

Expected values are never regenerated from Rust. `BLESS=1` rewrites `expected` from the Rust output, so a
changed `expected` is accepted only in a PR whose description names the `docs/README.md` Deviations row
(F/C) it implements.
