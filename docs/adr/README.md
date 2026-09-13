# Wi architecture decision records

This directory is the canonical ADR index for Wi.

## Canonical numbering

The implementation plan originally listed ADR-0001 through ADR-0008. Later architecture discussion used temporary conversational labels ADR-009 through ADR-014. Those labels were not a second independent ADR series; several repeated decisions already captured under the canonical numbering.

The reconciled mapping is:

| Conversational label | Decision | Canonical ADR |
|---|---|---|
| ADR-009 | No `codex app-server` fallback | [ADR-0006](0006-no-app-server-fallback.md) |
| ADR-010 | Backend-owned runs | [ADR-0004](0004-backend-owned-runs.md) |
| ADR-011 | Partial provider responses | [ADR-0007](0007-partial-stream-policy.md) |
| ADR-012 | Tool-effect semantics | [ADR-0008](0008-tool-effect-ledger.md) |
| ADR-013 | Host-unrestricted filesystem | [ADR-0009](0009-host-unrestricted-filesystem.md) |
| ADR-014 | Plugin-specific integration | [ADR-0010](0010-plugin-specific-integration.md) |

This avoids duplicate ADRs that would give Codex two files for the same decision. ADR-0011 and ADR-0012 are existing v0.1 decisions; the v0.2 provider architecture therefore begins at ADR-0013 and does not reuse temporary conversational numbering from planning inputs.

## Index

| ADR | Title | Status | Implementation |
|---|---|---|---|
| [0001](0001-node-typescript.md) | Node.js and TypeScript runtime | Accepted | Yes |
| [0002](0002-browser-websocket.md) | HTTP plus multiplexed browser WebSocket | Accepted | Yes |
| [0003](0003-per-session-sqlite.md) | Catalog database plus one SQLite database per session | Accepted | Yes |
| [0004](0004-backend-owned-runs.md) | Backend-owned runs independent of browser lifetime | Accepted | Yes |
| [0005](0005-direct-provider-adapters.md) | Direct provider adapters and OpenAI authentication modes | Accepted | Contract/fake only |
| [0006](0006-no-app-server-fallback.md) | No `codex app-server` fallback | Accepted | Enforced by absence/tests |
| [0007](0007-partial-stream-policy.md) | Partial-stream and tool-call promotion policy | Accepted | Yes |
| [0008](0008-tool-effect-ledger.md) | Durable tool-effect ledger and recovery semantics | Accepted | Yes |
| [0009](0009-host-unrestricted-filesystem.md) | Host-unrestricted personal filesystem policy | Accepted, deferred | No real file tools yet |
| [0010](0010-plugin-specific-integration.md) | Plugin-specific integration behind the Wi tool contract | Accepted, deferred | No plugins yet |
| [0011](0011-linux-only-v0.1.md) | Linux-only v0.1 runtime and release gate | Accepted | Yes |
| [0012](0012-trusted-local-user-storage-boundary.md) | Trusted local operating-system user storage boundary | Accepted | Yes |
| [0013](0013-multiple-provider-connections.md) | Multiple provider connections with explicit account selection | Accepted | M11 API-key foundation implemented; OAuth extension planned for M13 |
| [0014](0014-wsl-file-credential-store.md) | WSL-safe file CredentialStore with optional keyring later | Accepted | M11 file/environment stores and recovery implemented; keyring deferred |
| [0015](0015-provider-chain-and-cache-affinity.md) | Provider-chain identity, run pinning, and cache-affinity boundaries | Accepted | M11 run pinning/chain identity implemented; transport cache work planned for M14 |
| [0016](0016-automatic-routing-gate.md) | Telemetry-gated, opt-in automatic routing | Accepted | Explicit only in Milestone 11; gate in Milestone 15 |
| [0017](0017-openai-state-reasoning-and-transport.md) | OpenAI state, reasoning, and HTTP/SSE-first transport | Accepted | Planned: Milestones 12–14 |

## ADR rules

- Accepted ADRs are architectural source of truth.
- Implementation changes that contradict an ADR require an explicit amendment or a new superseding ADR.
- Do not create a duplicate ADR when an existing ADR already covers the decision.
- A deferred ADR fixes a future boundary but is intentionally not implemented in the first vertical slice.
- The plan may narrow implementation scope, but it may not silently reverse an accepted ADR.
