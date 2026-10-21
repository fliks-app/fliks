# Golden vectors

Each `<set>/cases.json` holds inputs and expected outputs of one function, replayed by the test its
spec's Vectors section names. `playback-info/engine-playback.recorded.json` is recorded from the engine.

A behaviour change rewrites `expected` from the Rust output with `BLESS=1`, in the same PR as its spec.
