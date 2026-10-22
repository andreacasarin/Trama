# ADR: Test boundaries and native Obsidian validation

- Status: Accepted
- Date: 2026-10-22
- Related: [LangChain and SQLite note index](langchain-sqlite-note-index.md)

## Context

Repository tests can verify Trama-owned logic and contracts, but simulated DOM behavior does not establish how Obsidian's native UI or runtime behaves. The repository already provides a generated demo vault and a real-Obsidian checklist.

## Decision

Keep automated unit and integration tests focused on Trama-owned logic, contracts, and integrations. Keep regression checks for SQLite query shape and transferred data where they protect bounded database computation. Keep the SQLite worker method tuple, types, limits, and safe errors in one protocol contract, validate requests exhaustively, and guard hot production SQL with query-plan tests so coverage tracks executed statements. Do not use simulated Obsidian UI tests as evidence of native behavior or add a replacement test framework for this boundary.

Validate behavior that depends on Obsidian's actual UI or runtime in the marked generated demo vault, opened in Obsidian. The existing [demo-vault guide](../../docs/demo-vault.md) is the procedure for settings persistence, Lente search and result opening, Filo refresh and related notes, Voce note and skill suggestions, and chat actions. Check streaming and scroll-follow behavior only when the configured provider supports streaming. Run provider-dependent checks only when the corresponding embedding or chat provider is configured. Report each host check as passed only after performing it in Obsidian.

Use only the generated demo path for these checks; the committed source fixtures and personal vaults are not targets. The [test-vault guide](../../test-vaults/README.md) documents the source-versus-generated distinction and path safety. The separate [Obsidian benchmark guide](../../docs/obsidian-benchmark.md) covers timing measurements on the generated benchmark vault; those measurements do not establish native UI behavior, personal-vault performance, or mobile performance.

## Rationale

Tests should assert behavior owned by Trama. Obsidian owns native suggestion, editor, settings, and view behavior, so checking those behaviors requires the real host. The existing generated demo vault provides a controlled fixture for that validation without treating simulated UI as native evidence.

## Consequences and reconsideration

Automated checks and actual-host checks provide different evidence and should be reported separately. Provider-dependent behavior remains unvalidated when no matching provider is configured. Reconsider this boundary if the approved validation workflow changes.
