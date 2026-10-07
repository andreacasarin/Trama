# Repository guidance

Prefer SQLite for computation over indexed data: filtering, grouping, deduplication,
ranking, vector scoring, and cache reconciliation. Use native SQLite/WASM functions
for heavy arithmetic; do not transfer corpus vectors to JavaScript for calculation.
Keep JavaScript focused on orchestration, bounded input preparation, and UI results.

Before adding a query, scan, temporary index, or background operation, check whether
existing indexed data or the current operation already supplies the result. Maintain
reusable indexes during writes instead of rebuilding them for each search. Preserve
ranking behavior, bounded scratch storage, and cancellation between SQL steps.
Measure performance changes on the same workload and add regression coverage for
query shape or transferred data when repeated work was the cause.
