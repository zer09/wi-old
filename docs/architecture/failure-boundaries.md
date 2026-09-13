# Wi v0.1 failure boundaries

Status: canonical for the first vertical slice

## 1. Principle

Wi does not hide failures through undocumented fallbacks. It fails the smallest reasonable fault domain, persists a safe state when possible, informs the browser with a bounded error, and writes a detailed redacted diagnostic.

```text
fault occurs
  -> classify fault domain
  -> commit durable failure/interruption state when possible
  -> stop or replace only the affected component
  -> notify subscribers with diagnosticId
  -> preserve unrelated sessions and server availability
```

## 2. Fault-domain hierarchy

From smallest to largest:

```text
browser request/message
browser connection
provider step
tool execution
run
session actor/session store
worker process/thread
project service/plugin
catalog/storage subsystem
Wi server process
```

A failure escalates only when the smaller domain can no longer be trusted or isolated.

## 3. Browser-message failure

Examples:

- malformed JSON
- unsupported protocol version
- unknown command
- command-ID conflict
- unauthorized command

Action:

- reject the message with a typed safe error
- when a global command already has a durable terminal failure, reuse its safe code, message, and diagnostic ID on every identical retry
- for rejected WebSocket upgrades and direct HTTP errors, return the same opaque diagnostic ID in the bounded response and redacted server record
- classify an unavailable corrupt actor during subscription setup as non-recoverable `storage.corrupt`, not a retryable replay query
- do not mutate session state
- keep the connection open for ordinary recoverable mistakes
- close the connection for repeated abuse, severe size violations, or authentication/origin failure

No run is cancelled.

## 4. Browser-connection failure

Examples:

- network loss
- tab closed
- heartbeat timeout
- slow-consumer queue overflow

Action:

- remove that connection's subscriptions
- discard only non-durable connection buffers
- continue backend runs
- allow reconnect and replay from committed sequence cursors

## 5. Provider-step failure

Examples:

- transient connection failure before output
- invalid provider event
- stream closes without terminal event
- post-output transport failure
- provider returns an explicit failed response

Action:

- classify the error
- retry only under the partial-stream policy
- preserve committed partial text and mark it interrupted when required
- discard/non-execute staged tool calls when terminal completion was not accepted
- fail or interrupt the affected provider step and run
- generate one diagnostic ID at the failure boundary
- emit a bounded, server-authored `provider.step.failed`/`interrupted` and `run.failed`/`interrupted` message using that diagnostic ID
- report raw failure detail only to the redacting diagnostic sink; never persist provider exception or provider-reported failure text

Do not invoke `codex app-server` or silently change provider/endpoint/transport.

## 6. Provider-adapter invariant failure

Examples:

- impossible event ordering
- duplicate response identity with conflicting content
- parser state corruption
- internal adapter assertion failure

Action:

- terminate or reset the affected adapter worker/resource
- fail the active run using a provider-protocol diagnostic
- start a clean adapter resource for later runs when safe
- keep unrelated sessions and the web server alive

A provider adapter may live in-process for lightweight asynchronous I/O, but an invariant failure must still be isolated at run/resource scope rather than crashing all sessions unless shared memory corruption is suspected.

## 7. Tool-execution failure

Examples:

- schema validation failure
- approval denied
- timeout
- cancellation
- tool throws
- worker dies

Action depends on the tool state and effect class:

- before `started`: return a normal denied/failed result when appropriate
- pure/read-only started with no result: eligible for controlled retry
- transactional local effect: reconcile intended and observed state
- non-idempotent effect with unknown outcome: mark `outcome_unknown`; never retry automatically

Commit the ledger outcome before provider continuation. A failed, cancelled, or unknown tool outcome receives one diagnostic ID; its durable event and redacted server diagnostic reuse that ID with session, run, step, call, tool, and error-code context. When an unknown outcome interrupts the run, the run terminal event reuses the same ID.

## 8. Run failure

A run fails when its provider/tool loop cannot safely continue.

Action:

- transition exactly once to `failed`, `cancelled`, or `interrupted`
- map the durable/browser message from the stable error code; never trust arbitrary `RunTaskResult.message` or exception text
- generate one diagnostic ID at the actor boundary when the run task did not already report one
- persist partial assistant content and the bounded server-authored message
- write raw run-task or cancellation-cleanup detail only through the redacting diagnostic sink using that same ID
- release scheduler permits
- terminate or detach active resources according to policy
- keep the session available for a later user message/resume decision

A run failure does not terminate its session database or the server.

## 9. Session failure

Examples:

- dedicated database corruption
- conflicting event at an existing sequence
- irreconcilable migration failure
- actor invariant corruption limited to one session

Action:

- stop accepting mutations for that session
- mark the session unavailable
- close its actor and database handle
- preserve the file in place for diagnostics/recovery
- update catalog status when possible
- keep other sessions running

Catalog `unavailable` and `missing` states are authoritative, not UI hints. Normal storage clients hold a per-session coordination boundary from the final status check through each read, recovery, or command/append worker response. Existing homes are realpath-canonicalized before coordinator and database paths are derived, so static symlink aliases share that boundary. Catalog status transitions use the same boundary, so they wait for earlier work and block later work until it rechecks the committed state; rejection closes retained worker handles. Generic lazy reconciliation requires an existing `ready` session: it cannot insert an absent row or restore an isolated row. Reconciliation may reconstruct an absent row only through module-internal incomplete-creation recovery backed by a durable `creating` reservation, or through the complete-discovery repair path after validating the canonical database, schema, size, identity, projection, and creation provenance; unrelated sessions remain usable throughout. The validated-repair RPC is reachable only through module-closure state, not client fields or prototype symbols. Worker pools and client hooks are JavaScript-private, and their constructors are absent from the normal package runtime exports; internal test-only access is environment-gated and not exported by the package.

## 10. Database-worker failure

Examples:

- worker thread exits
- unhandled worker exception
- worker RPC response is invalid

Action:

- reject all in-flight requests assigned to that worker with typed errors
- log affected request/session IDs
- spawn a clean replacement
- lazily reopen session databases
- reconcile sessions whose operation outcome is uncertain

The server terminates only when repeated worker failures make persistence unreliable across the system or the catalog cannot be opened safely.

## 11. Catalog failure

Examples:

- catalog migration failure
- catalog corruption
- catalog path unavailable

Because catalog discovery is foundational, normal startup may stop. A first run creates the missing configured `WI_HOME` directory chain synchronously with mode `0700` before catalog-worker construction, then realpath-canonicalizes the created or existing directory. Existing components are not moved, overwritten, deleted, or chmodded. A non-directory, inaccessible component, or other creation/canonicalization failure maps to a fixed bounded `storage.operational` error before any storage worker or HTTP listener starts. Before an existing catalog is opened read-write, SQLite recovery, integrity checking, and migration validation run on a disposable copy of the database and WAL/SHM sidecars. Startup then uses a two-phase handshake: SQLite acquires the canonical handle without running project configuration, the worker synchronously compares current directory and DB/WAL/SHM path identities with the validated snapshot, and only a visible match may proceed to recovery-capable PRAGMAs or queries. A visible mismatch closes the raw handle. Missing bootstrap uses final-component no-follow/no-overwrite reservation before the same prepared-open flow. These checks are defense-in-depth; [ADR-0012](../adr/0012-trusted-local-user-storage-boundary.md) explicitly excludes hostile concurrent same-user TOCTOU/ABA substitution. Fixed catalog-startup classifications replace raw filesystem messages before RPC, preventing canonical-home and probe-path disclosure. Ordinary validation failure leaves the canonical files unopened and unchanged. Automatic quarantine/replacement is forbidden because Node exposes no cross-platform handle-relative, no-follow, no-overwrite move. With Wi stopped, an operator may restore the catalog or deliberately relocate it outside Wi before using the missing-catalog rebuild path.

Action:

- emit a clear fatal diagnostic
- close the catalog handle without renaming, deleting, overwriting, or recreating the corrupt pathname
- avoid mutating session databases during uncertain discovery
- provide a maintenance/rebuild path from session manifests
- terminate the Wi server when safe operation cannot be guaranteed

A catalog summary-write failure after a committed session event is not fatal. It is a stale-index condition repaired by reconciliation.

## 12. Plugin/project-service failure

Plugins are not part of the first slice, but the boundary is fixed.

Action:

- fail the affected tool execution
- terminate and replace the plugin worker/process when safe
- preserve the session and server
- pin diagnostic data to plugin ID/version and tool call
- do not expose a different plugin behavior as a silent fallback

## 13. Wi server fatal conditions

The entire process should terminate only for conditions such as:

- catalog cannot be opened or migrated and no safe read-only/rebuild mode is implemented
- global configuration is invalid before serving
- core event-store invariants are violated across unknown scope
- credential/storage initialization fails in a way that would risk exposure or corruption
- unrecoverable main-thread exception where continued state cannot be trusted
- an in-process provider or tool that exceeds its cancellation deadline, because abort is not proof of termination and v0.1 has no smaller hard isolation boundary

An in-process cancellation deadline failure terminates the production process nonzero immediately after a redacted fatal diagnostic. Wi does not first claim that the resource was detached, terminalize the run, or release its scheduler permit. Restart recovery conservatively handles the still-nonterminal durable state.

Before graceful termination, Wi attempts to:

- stop accepting new commands
- notify connected browsers
- cancel/drain active operations according to policy
- terminate tool process groups
- flush database worker queues
- close handles
- write final redacted diagnostics

Startup and shutdown use one explicit lifecycle. Runtime readiness is memoized. Recovery candidates are requested and adopted in cursor pages of at most 1,000 IDs rather than accumulated installation-wide, and server-owned closing state is checked before and after every page request and at each adoption boundary. If shutdown wins, remaining startup adoption is cancelled before closed actors or storage are used; close-induced failures from work already crossing an asynchronous boundary are treated as cancellation rather than a second fatal startup failure. All runtime and nested worker scalar bounds are validated before any provider, scheduler, storage worker, or actor registry is constructed. Shutdown begins under one server-owned absolute deadline; each actor, scheduler, storage, listener, and worker phase receives only the remaining budget. A deadline that leaves an in-process operation, worker, or other non-isolatable component unresolved is accumulated into one redacted `server_shutdown_diagnostic` with a diagnostic ID and causes nonzero process exit; a final watchdog covers bugs outside the bounded paths. A transport drain timeout is instead a successful bounded isolation when Wi force-closes every owned socket and listener at that hard boundary. It emits a component warning such as `http_shutdown_forced`, later shutdown phases continue, and the process may exit zero. Failure to complete that forced isolation remains an aggregated shutdown failure. Shutdown begins closing the HTTP listener immediately; non-upgraded sockets drain only until the configured HTTP deadline, then incomplete or stalled connections are force-closed. Every socket entering the HTTP upgrade path transfers to gateway ownership before validation; rejected sockets have a fixed bounded response-drain window and are force-destroyed on its expiry or immediately during gateway shutdown. Accepted WebSockets remain under the same gateway deadline. A rejected WebSocket connection cleanup is treated like a timeout: remaining transports are terminated before errors are reported, custom logger failures cannot block isolation, and WebSocket-server close is attempted through an unconditional bounded path. If startup fails after the HTTP listener opens, Wi applies the same bounded listener cleanup, stops the WebSocket gateway, and then closes runtime storage before rejecting startup. Concurrent close waits for startup cleanup without awaiting itself. During graceful cancellation, the actor preserves a run task's diagnostic-bearing terminal result; a provider-step interruption and its resulting run interruption therefore share one causal diagnostic ID instead of replacing it with a synthetic stop result.

A sudden crash may bypass these steps; recovery tests cover durable consequences. The complete process project is a required Linux CI job, including owner-death cleanup and directory-symlink scanner containment. Process fixtures share bounded process-tree cleanup through detached Linux process groups, escalation, verified group disappearance, and temporary-home deletion only after cleanup settles. Linux uses operating-system signals plus a test-support-only owner watchdog. The harness clears inherited and caller-provided `NODE_OPTIONS` for every harness-owned Node child. The watchdog therefore installs its inherited owner-pipe watcher without executing preload hooks, and a fixed bootstrap remains the actual fixture process so caller `--import`/`--require` code cannot run ahead of ownership. Watchdog-only release-test controls are removed from the anchor and fixture application environment. The bootstrap's gated preload releases the requested fixture module only after watchdog registration. The preload starts a minimal process-group anchor before fixture code; its kernel-held membership keeps the detached group identity allocated after direct-leader exit, preventing numeric PGID reuse from retargeting cleanup to an unrelated group. Owner EOF reclaims this anchored fixture group. Normal completion releases the watchdog after verified group cleanup, and setup failure leaves fixture code gated and fails closed. A signal requested through a watchdog-owned fixture handle targets its direct leader while the anchor and descendants remain under watchdog ownership. Explicit cleanup delegates anchored-group reclamation to the watchdog before any direct group signal. Watchdog release caches only one active attempt: a timeout or supervisor error clears that attempt but retains ownership and the anchor-held identity, so later cleanup retries cannot target a reused PGID; ownership is removed only after the fixture group and watchdog are both verified gone. A disconnected live watchdog that has not accepted reclamation is stopped while the anchor still reserves the group, then the harness reclaims that exact group and verifies both boundaries gone. Watchdog acceptance is authenticated and precedes its first group signal; once accepted, the harness refuses numeric fallback and fails closed unless watchdog-owned reclamation can be verified. Watchdog readiness failure verifies watchdog disappearance before returning. If setup fails after the anchor starts, bounded escalation verifies the group, leader, and watchdog are gone before the ownership record is deleted and the setup error is returned. Generic fixture runners likewise verify and release their owned Linux process group after normal leader exit instead of dropping ownership from cleanup tracking. Both fixture harnesses retain only fixed 64-KiB stdout/stderr diagnostic tails plus total-byte, truncation, and streaming-hash metadata. Real-server object IPC has fixed per-message estimated-byte, depth, node, string, and type limits plus independent pending/history message and estimated-aggregate caps. Its conservative estimate charges complete JSON string/key escaping and finite-number encodings plus structural overhead, keeping retained UTF-8 JSON size at or below the charged aggregate. Non-finite numbers are protocol-invalid and are summarized on retention or rejected by outbound preflight before JSON-mode IPC can coerce them to `null`. Over-limit values are never placed in pending/history as full objects: the harness retains only a bounded type/reason/preview/hash summary and exact monotonic message counters, while pending eviction prefers awaited small controls over unawaited noise. Accepted callback values are copied into bounded plain-data snapshots before retention, and their exact retained representation is charged to pending/history. Waiters and history readers receive fresh bounded copies, and each diagnostics read copies its bounded truncation record, so external mutation cannot alter retained memory, evidence, or counters. Timeout diagnostics remain bounded. Parent controls are copied through data descriptors into a bounded plain-data snapshot; arrays capture one own length descriptor and are rebuilt with a null prototype, accessors and unsupported values fail before send, and the exact captured snapshot—not the dynamic source object—is passed to `child.send()`. This bounds each trusted parent control representation, not aggregate in-flight buffering across repeated `child.send()` calls. Because Node deserializes object IPC before invoking JavaScript, this guarantee starts at the receive callback and assumes trusted test fixtures; a future untrusted child boundary must replace object IPC with bounded framing. Readiness matching remains streaming with a fixed marker bound rather than a search over accumulated output. Output volume alone never triggers child termination; existing deadlines and verified process-tree cleanup remain authoritative. A graceful-shutdown-during-tool probe proves that a noncooperative pure tool exits fail-closed and that restart safely retries the same durable ledger row rather than inventing a terminal outcome. Separate retained-gate probes show that replay is isolated cleanly while a noncooperative catalog observation reaches the shared deadline, reports failure, and recovers after restart. When restart recovery terminalizes related provider-step, tool, and run state as one causal boundary, those events share one diagnostic ID and one redacted `session_recovery_interrupted` server record. When a provider-step terminal event committed before the crash but its run terminal event did not, the provider-step projection retains the canonical diagnostic ID and run adoption reuses it. The complete failpoint inventory, scanner trigger policy, catalog/project limitations, and shutdown order are documented in [the Milestone 7 failure and recovery matrix](failure-recovery-matrix.md).

## 14. Error categories

Use stable categories rather than relying only on free-form messages.

Initial categories include:

```text
protocol_error
authentication_error
authorization_error
command_conflict
invalid_state
resource_limit
provider_transient_error
provider_protocol_error
provider_terminal_error
provider_stream_interrupted
tool_validation_error
tool_denied
tool_timeout
tool_execution_error
tool_outcome_unknown
storage_error
storage_corruption
worker_crash
migration_error
internal_invariant_error
```

## 15. Browser error shape

A safe durable or connection-level error contains:

```json
{
  "category": "provider_protocol_error",
  "message": "The provider stream ended with an invalid event sequence.",
  "diagnosticId": "err_01...",
  "recoverable": false
}
```

Do not include secrets, stack traces, raw authorization material, or unbounded provider payloads.

## 16. Structured logging

Every log record should include available identifiers:

```text
diagnosticId
requestId
commandId
clientId
sessionId
runId
stepId
callId
workerId
pluginId
```

Untrusted malformed payloads and exception messages are sampled to a fixed-size prefix before regular-expression scrubbing, UTF-8 encoding, or hashing. Logs retain source unit/length, sampled byte length, sampled digest, and a truncation flag rather than raw content or a synchronous full-input digest. A provider diagnostic record reuses the diagnostic ID stored in its safe durable failure event. Injected loggers are wrapped once in a non-throwing adapter; logging failure may discard a record but never changes rejection, isolation, persistence, or cleanup control flow. The production stdout sink handles stream errors, drops while backpressured, resumes only on `drain`, and disables itself permanently after sink failure, so `EPIPE` cannot terminate the backend and stalled output cannot build an application-level queue. Every in-band protocol rejection and every pre-upgrade or HTTP-parser rejection records the same diagnostic ID returned to the browser or raw HTTP peer.

Mandatory redaction:

- API keys
- OAuth access/refresh tokens
- authorization headers
- cookies
- authorization codes
- sensitive callback query values
- Milestone 11 [`CredentialStore`](../adr/0014-wsl-file-credential-store.md) references when they reveal paths or handles (the released v0.1 product has no provider credential store)
- arbitrary provider/tool payloads beyond bounded reviewed previews

## 17. No hidden fallback

Wi must not respond to a direct adapter failure by:

- launching `codex app-server`
- switching ChatGPT-plan usage to Platform API billing
- switching accounts
- changing model
- changing provider endpoint
- changing transport after semantic output has begun

A documented, same-adapter pre-output transport retry may occur under the retry policy. Every other change requires an explicit user action and durable audit event in later milestones.

## 18. Failpoints

Test-only failpoints are placed at critical crash windows:

```text
after_command_event_insert_before_commit
after_command_commit_before_ack
after_event_commit_before_publish
after_tool_requested_commit
after_tool_started_commit
after_tool_result_commit_before_provider_continue
after_provider_text_commit
after_run_terminal_commit
after_session_create_before_catalog_ready
after_catalog_session_repair
after_catalog_replacement_before_repair
after_provider_lifecycle_prepare
after_provider_file_effect
after_provider_file_observed
after_provider_lifecycle_terminal_before_ack
after_provider_stage_cleanup
after_provider_stage_temp_flush
after_provider_credential_temp_flush
after_provider_stage_commit
before_provider_provisioning_ref_return
after_recovery_admission
after_recovery_prepare
after_environment_run_acceptance_before_request
after_provider_stage_delete_before_flush
after_provider_credential_rename_before_flush
after_provider_credential_unlink_before_flush
after_provider_stage_rename_before_flush
```

A process test starts Wi, arms the failpoint with a strict test-only session/command/run or catalog-global selector, triggers the boundary, restarts using the same `WI_HOME`, and verifies the exact durable outcome. Run-scoped selectors bind in two stages: `commandId` and `sessionId` identify the target command when its deterministic selected `runId` is assigned, then committed publication/provider/tool/run boundaries match `sessionId + runId` before consuming the crash one-shot; they do not recheck `commandId` at that later boundary. Concurrent-session cases hold target A before the boundary, let unrelated B cross it without terminating Wi, then release A and require the documented exit. Unrelated sessions or commands cannot acquire the selected run ID or consume the one-shot.

## 19. Recovery expectations

```text
uncommitted mutation
  -> absent after restart

committed event not published
  -> replayed after reconnect

stale catalog summary
  -> repaired from session database

streaming provider step
  -> interrupted

pending approval/input
  -> restored pending

completed tool result
  -> reused, not executed again

started ambiguous non-idempotent effect
  -> outcome_unknown

completed run
  -> remains completed
```

## 20. Testing fault isolation

Automated tests must prove:

- session A provider failure does not stop session B
- one malformed browser message does not crash the gateway
- slow browser A does not delay browser B or the run
- database-worker death does not terminate the server
- corrupt session A is marked unavailable and preserved without blocking session B
- provider protocol failure never invokes a fallback
- diagnostic logs are redacted and bounded
- fatal catalog failure prevents unsafe startup
