# TalaDB 0.11.3 evaluation decision

Date: 2026-09-12  
Candidate: `taladb@0.11.3` and `@taladb/web@0.11.3`

## Approved boundary

The candidate is validated and supported through the representative 25,000-chunk
native run: approximately 401 seconds, exact recall `1.0`, maximum score error
`6.98e-8`, with mutation, convergence, and restart checks passing.

The 50,000-chunk profile is explicitly unsupported. The actual Worker/WASM run
failed with `Error: unreachable`, and an earlier restart attempt reached
approximately 1.93 GiB. The 100,000-chunk profile was not run and is unsupported.
This scale boundary was explicitly accepted for committing the evaluation candidate;
it is not a claim that larger profiles pass.

Gate 0 availability, local asset, browser-runtime, and checkpoint evidence is recorded
in [taladb-0.11.3-gate0.md](./taladb-0.11.3-gate0.md).
