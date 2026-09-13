# Wi v0.1 and v0.2 Milestone 11 known limitations

These are intentional implemented-slice boundaries, not hidden roadmap promises.

## Provider and model

- Provider execution remains deterministic and fake/no-network.
- There are no OpenAI Platform calls or live endpoint probes.
- There is no ChatGPT/Codex OAuth adapter.
- Milestone 11 includes the nonsecret provider-connection catalog, file/environment `CredentialStore`, explicit future-run selection, immutable run snapshots, lifecycle recovery, and browser management.
- File API keys can be provisioned and stored locally, but they are consumed only by the deterministic no-network fixture in this milestone; there is no live OpenAI API-key transport.
- There is no live connection-specific model discovery, provider-state persistence, or prompt-cache telemetry.
- Wi does not invoke or fall back to `codex app-server`.
- There is no automatic provider, model, endpoint, account, workspace, authentication-mode, transport, or billing switch.

## Tools and projects

- Only safe deterministic test tools (`echo`, `guarded_echo`, and controlled delay behavior) exist.
- There is no real shell/process tool exposed to the model.
- There are no general filesystem read/write/edit tools in the product.
- CodeGraph, Context Mode, MCP/plugin services, project indexing, and arbitrary plugins are not implemented.
- The project model does not yet provide production project registration/management workflows in the GUI.

## Deployment and users

- Server operating system support is Linux only.
- Production binds only to `127.0.0.1`.
- Remote access and deployment are not supported.
- Wi assumes one trusted operating-system user; it has no human-user accounts, roles, permissions, or tenant isolation.
- Hostile same-user mutation of `WI_HOME` while Wi is running is outside the threat model.
- There is no Windows or macOS server support or CI.

## Storage and data lifecycle

- There is no production backup command, session-export API/UI, import command, or restore wizard.
- A stopped full-directory copy is the only documented manual backup procedure.
- Project catalog metadata is not reconstructable solely from session manifests.
- Retained pre-v4 session databases cannot reconstruct an already-lost original `session.create` command ID.
- Corrupt/unsupported databases are preserved and marked unavailable; there is no automatic repair of canonical session contents.
- Session databases may accumulate indefinitely; there is no compaction, retention policy, archival UI, or cross-session full-text search.
- Large content-addressed artifact/blob transfer is deferred; `/blobs/` and `/files/` return not implemented.

## Browser and interface

- The GUI is functional rather than polished.
- One browser connection can multiplex sessions, but there is no offline mode.
- Browser refresh/reconnect can temporarily show replaying/reconnecting states.
- Slow consumers are disconnected and must recover through replay.
- Browser SSE is not available.
- There is no session export UI or rich operational administration UI.

## Runtime and operations

- Most concurrency, queue, replay, and worker limits are fixed internal defaults rather than user-tunable environment settings.
- A non-cooperative in-process provider/tool that ignores cancellation beyond the bounded shutdown policy is process-fatal in this slice; restart recovery protects durable state.
- SQLite work is isolated in workers, but the installation still uses one local process and local files rather than distributed scheduling/storage.
- Logs are structured diagnostics written to standard output; there is no log rotation or metrics/telemetry service.
- No automatic updater, package installer, binary distribution, or service-unit installer is provided.

## Testing constraints

- Property/fuzz profiles are time-budgeted and can overshoot because durable histories and companion suites finish current work.
- Fast-check artifacts intentionally contain only bounded previews and identifiers, not complete arbitrary model/tool payloads.
- Browser E2E targets Chromium; cross-browser compatibility is not a v0.1 release gate.
- The final acceptance uses deterministic fake provider scenarios and test-only inspection controls; it does not validate any real provider or real host tool.

## Remaining planned v0.2 work

Milestone 11 implements isolated provider connections, explicit selection, and the file/environment `CredentialStore` without network access. The accepted [v0.2 provider-integration plan](plans/v0.2-openai-provider-integration.md) and [provider-connections architecture](architecture/v0.2-provider-connections.md) require later milestones to add, in order:

- OpenAI Platform Responses HTTP/SSE in Milestone 12;
- ChatGPT/Codex multi-account OAuth in Milestone 13;
- connection-scoped provider state, caching metrics, and provider WebSocket optimization in Milestone 14;
- telemetry collection and an explicit automatic-routing go/no-go gate in Milestone 15;
- real projects/tools and project services only in Milestones 16–17.

None of the Milestone 12–17 behavior is present in the Milestone 11 candidate or released v0.1 product. Future implementation must preserve the established provider boundary, backend ownership, durable event/tool semantics, local security rules, explicit account/billing identity, and no-fallback decisions. Automatic routing remains optional after its named gate; it is not a current capability or presumed v0.2 requirement.
