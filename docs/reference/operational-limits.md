# Wi v0.1 configuration and operational limits

This reference describes the production entry `apps/server/dist/main.js`. Most internal limits are intentionally fixed in v0.1; they are not environment configuration promises.

## Environment configuration

| Variable | Default | Validation | Effect |
|---|---:|---|---|
| `WI_HOME` | `~/.wi` | non-empty string | Root for catalog, session databases, artifacts, logs, and temporary files |
| `WI_PORT` | `4317` | integer `0..65535` | Loopback HTTP/WebSocket port; `0` selects an ephemeral port |
| `WI_SHUTDOWN_DEADLINE_MS` | `15000` | safe integer `100..120000` | Overall graceful shutdown budget; hard watchdog fires 2 seconds later |
| `WI_SESSION_DISCOVERY_LIMIT` | `1000` | safe integer `1..10000` | Maximum generated session directories inventoried during repair discovery |
| `WI_CATALOG_REPAIR` | unset | exactly `1` when present | Forces explicit catalog reconstruction |

The host is fixed to `127.0.0.1`; there is no bind-address option. Configuration is parsed before workers start. Unknown environment variables are ignored unless used by Node.js or the test harness; production test-failpoint variables are inert without both test mode and explicit gates.

## HTTP and browser bootstrap

| Limit | Value |
|---|---:|
| Header size | 16 KiB |
| Header timeout | 5 seconds |
| Request timeout | 10 seconds |
| Keep-alive timeout | 5 seconds |
| Static asset size | 5 MiB |
| Bootstrap session summaries | 1,000 maximum |
| Default HTTP shutdown timeout | 2 seconds |
| Maximum configurable internal HTTP shutdown timeout | 30 seconds |

Bootstrap reports `sessionsTruncated` when more than 1,000 rows exist. An explicit `?session=<id>` remains authoritative even if that session is omitted from the bounded page.

## WebSocket defaults

| Limit | Default |
|---|---:|
| Client frame size | 64 KiB |
| JSON container depth | 32 |
| Pending inbound frames | 64 |
| Pending inbound bytes | 512 KiB |
| Protocol violations before close | 3 |
| Subscriptions per connection | 64 |
| Outbound queued messages | 256 |
| Outbound queued bytes | 1 MiB |
| Single outbound message | 256 KiB |
| Replay live backlog | 1,024 events / 1 MiB |
| Replay live single event | 256 KiB |
| Historical replay page | 64 events |
| Historical page bytes | 257 KiB (`256 KiB` payload plus `1 KiB` envelope reserve) |
| Historical single event | 256 KiB |
| Replay queue wait | 5 seconds |
| Heartbeat interval | 15 seconds |
| Initial hello timeout | 10 seconds |
| Gateway shutdown timeout | 2 seconds |
| Process-wide pending recovery frames | 64 |
| Process-wide recovery command bytes (raw/canonical charge) | 512 KiB |

The process-wide recovery-ingress budget is shared by all authenticated WebSockets and direct backend routing. A frame reserves one count and its bounded raw/canonical command-byte charge before ingress registration; duplicates consume separate reservations and release exactly once when settled. These production limits are fixed and are not ordinary environment configuration; test-only constructor/composition overrides may lower them but may not raise them.

The server disables WebSocket compression. Slow consumers are disconnected rather than losing durable event frames. They recover through replay.

The durable command payload allowance is derived from frame, outbound, replay, and worker-RPC capacities and leaves a 4 KiB server-owned event-envelope reserve. The browser receives its effective limits in bootstrap and rejects oversized drafts before submission.

Internal gateway overrides are constructor-only test/composition options, capped by `WEBSOCKET_LIMIT_CAPS`; they are not production environment variables.

## Provider boundary

The v0.1 provider is deterministic fake only.

| Limit | Value |
|---|---:|
| Provider configuration | 48 KiB, depth 32, 4,096 nodes |
| Input items per request | 256 |
| Tool calls per step | 256 |
| Complete provider request | 512 KiB, depth 34, 16,384 nodes |
| Individual message text | 16 KiB UTF-8 |
| Cumulative response text per step | 16 KiB UTF-8 |
| Text delta | 16 KiB UTF-8 |
| Tool name | 256 bytes |
| Tool arguments envelope | 48 KiB |
| Provider failure message | 8 KiB |
| Provider response ID | 256 bytes |

Provider output remains provisional until a valid terminal event is accepted. A boundary violation fails the provider step/run and cannot promote staged tools.

## Storage and workers

| Limit/default | Value |
|---|---:|
| Catalog workers | 1 |
| Session worker pool | `min(4, max(2, availableParallelism() - 1))` |
| Open session handles per session worker | 32 |
| Worker request timeout | 10 seconds |
| Worker termination/close confirmation | 2 seconds |
| Worker RPC payload | depth 64, 20,000 nodes, 1,000,000 units |
| Storage event page hard maximum | 256 events / 1,000,000 bytes |
| Storage event-page envelope reserve | 1,024 bytes |
| Discovery page | 64 session databases |
| Discovery request timeout | 10–120 seconds depending on configured inventory limit |

Session IDs are stably assigned to the fixed worker pool. Handles are opened lazily and evicted least-recently-used within each worker. A timed-out write has an ambiguous transport outcome and must be reconciled by durable IDs; it is not blindly replayed.

## Runtime concurrency and lifecycle

| Default | Value |
|---|---:|
| Provider concurrency | 4 |
| Tool concurrency | 4 |
| Actor idle timeout | 60 seconds |
| Actor eviction scan | 30 seconds |
| Active runs per session | 1 |

Multiple sessions may run concurrently. Later submissions to a busy session become durable queued follow-ups. Browser connection count does not own actor or run lifetime.

## Provider credentials and connections

- File API keys are limited to 16 KiB and stored in envelopes no larger than 64 KiB.
- Backend-local credential FD input must finish within 30 seconds; timeout destroys the reader and fails without staging a credential. The 16 KiB limit is enforced on raw input bytes while one streaming UTF-8 decoder preserves multibyte code points split across read chunks.
- Credential and staging directories are mode `0700`; final and staged files are mode `0600`.
- Default credential roots use `${XDG_STATE_HOME}/wi` when absolute `XDG_STATE_HOME` is set, otherwise `${HOME}/.local/state/wi`. Relative configured roots are rejected before filesystem mutation. First-use provisioning may prospectively canonicalize an absent `WI_HOME` but creates only credential/staging directories outside it.
- Credential roots must be outside `WI_HOME`, on a supported Linux filesystem, and not under `/mnt/<drive>` or DrvFS/9p-like mounts. Mount inspection streams a bounded `/proc/self/mountinfo` view, decodes Linux octal path escapes including `\012`, and applies longest-mountpoint selection after decoding so unsafe nested mounts whose names contain whitespace or newlines cannot be skipped. Root semantic probes use strict random `.wi-probe-<32hex>.tmp/.done` names; initialization streams at most 4,000 entries for 10 seconds, removes only descriptor-verified current-user `0600` single-link regular probe files containing the exact probe marker, flushes deletion, preserves lookalikes, and rejects unsafe strict matches.
- Credential and recovery scans are closed, stream directory entries, retain at most 1,000 files/candidates, reject more than 4,000 total directory entries, and enforce a 10-second completed-work deadline.
- Provisioning references expire after 15 minutes; recovery references expire after 10 minutes and are process/scan-bound. Distinct commands racing for one provisioning source produce one durable owner and a durable `credential.provisioning_already_claimed` loser before any second connection/effect; loser retries never depend on the stage still existing. Recovery bindings set a synchronous pre-await `claiming` state so only one asynchronous exact rescan can consume a `recoveryRef`; concurrent callers receive `credential.recovery_already_claimed`. Recovery scanners retain only canonical nonsecret metadata and keyed HMAC evidence, schedule server-side cleanup at exact epoch expiry, clear cached candidates/bindings, and zero fingerprint/key buffers without waiting for another request. A successfully consumed claim detaches an independently owned keyed verifier for catalog reservation and final file verification; public epoch cleanup cannot invalidate it, and the verifier explicitly zeroizes/disposes its key and fingerprint on every terminal path. Initial claim persists bounded nonsecret stage descriptor identity (device, inode, size, high-resolution ctime) captured by the same no-follow read, and every post-prepare/restart read must match it before key publication; no credential-derived hash is stored. Terminal pre-effect failure immediately attempts claimed-stage deletion; startup retries interrupted cleanup under the 1,000-stage, 4,000-entry, and 10-second bounds. Cleanup reads only exact-`0600` stages.
- File lifecycle effects commit through `prepared` → `file_observed` → terminal catalog phases. Startup reconciles either the reserved old binding, reserved target binding, or exact deletion evidence without guessing. Catalog-only disable instead commits its cutoff and terminal result atomically in one catalog transaction.
- The closed test-only provider crash inventory includes `after_provider_credential_rename_before_flush` (exit 114), `after_provider_credential_unlink_before_flush` (exit 115), and `after_provider_stage_rename_before_flush` (exit 116). They are reachable only with `NODE_ENV=test`, `WI_ALLOW_TEST_FAILPOINTS=1`, and a validated provider-command selector; browser, catalog, provider, and ordinary production environment data cannot select them. Each exits the child process immediately after the namespace mutation and before the containing-directory fsync.
- Recovery commands durably enter `validating` before consuming a memory-only recovery reference. A status read may return final `not_accepted` only after observing a closed epoch, drained ingress, and a second empty durable lifecycle/metadata lookup; a stale initial absence therefore cannot hide a terminal operation. Occupied original connection identity, authoritative identity ownership, and evidence claimed by another command remain distinct stable failures: `credential.recovery_connection_conflict`, `credential.recovery_identity_conflict`, and `credential.recovery_already_claimed`; initial rejection, identical retry, restart, and status preserve the same code. Both discovery and claim compare a second complete root-membership snapshot plus keyed process-local fingerprints of secret bytes before exposing or consuming references, and the service verifies the claimed evidence once more before restore. Fingerprints never enter safe results. Restart expires stranded validating admissions; exact claim restores authoritative identity only when workspace presence is explicit `none` or a concrete value; `unknown` workspace is not treated as globally unique.
- Catalog-loss recovery remains durably active while any retained credential envelope is not represented by the rebuilt catalog. Each successful claim refreshes that marker, so multiple envelopes can be recovered across process restarts; recovery closes only after a bounded closed scan proves no unrepresented envelope remains.
- Final recovery claim persists bounded nonsecret descriptor identity (`device`, `inode`, `size`, high-resolution `ctime`) captured by the same no-follow read; no credential-derived hash or fingerprint is persisted. Restart requires this identity plus exact envelope binding. A claimed source that changes before durable observation—including a secret-only atomic replacement—terminalizes with `credential.recovery_source_changed`, retains the original connection/generation as an unavailable recovery tombstone, consumes the claim, and requires explicit staged replacement. Successful replacement clears the tombstone.
- Provider connections have a hard installation maximum of 1,000 rows, enforced transactionally on environment registration, file reservation, and catalog-loss recovery after exact retry/identity-winner handling. The 1,001st distinct connection fails with `provider.connection_limit_exceeded` before insertion. Browser provider lists therefore expose every normally admitted connection in one bounded safe projection plus a monotonic catalog revision; exact default/run selection uses the exact connection lookup rather than that list. Recovery scans are globally single-flight per backend process. Recovery status reads never return a recovery reference and enforce a fixed aggregate in-flight cap plus a fixed per-second process-wide admission window. Browser catalog-refresh and recovery-reconciliation cycles are single-flight, poll no more often than every two seconds, abort each cycle after five seconds, ignore late results, and abort active work when the panel unmounts.
- Environment credentials share the 16 KiB UTF-8 API-key limit. The bound is checked before fingerprinting at run acceptance and again before hashing or issuance on every request re-read; oversized values fail with `credential.environment_invalid` and the matching connection becomes unavailable. Fingerprints are never persisted.
- Catalog-global commands share one command-ID namespace across `catalog_commands`, provider lifecycle operations, and provider metadata operations. Symmetric transactional checks make cross-method/content reuse conflict regardless of admission order; concurrent claim attempts yield one owner and one conflict.
- Run acceptance holds a per-connection process lease from final authoritative selection validation through the session acceptance commit. Lifecycle cutoffs use the same boundary and wait for earlier acceptance leases; a cutoff committed during preliminary capability resolution is observed by final revalidation and prevents any user-message/run commit. The lease is released on both acceptance and rejection.
- Every provider request acquires a connection/revision/generation-bound process lease under the same per-connection cutoff lock used by lifecycle preparation. File leases also verify the exact current envelope. The lease issues the API key only through a request-scoped backend callback, clears its retained reference on release, and is reacquired for every post-tool continuation.
- Shutdown stops new provider-connection admission, drains lifecycle tasks, recovery ingress, connection locks, and request leases within the shared deadline, then clears process-only scanner/credential state. Storage is not closed underneath undrained provider work; deadline failure is reported as a shutdown failure.

## Logs and untrusted data

Structured log data is bounded by depth, entry count, key length, and string length. Sensitive key concepts, cookies, authorization values, token-like text, URL credentials, and query strings are redacted. Error messages are represented by bounded fingerprints rather than raw untrusted text. Logs are diagnostic output, not an audit database.

## Fuzz limits

- fast-check seed: `1..2147483647`
- deterministic run/operation override: `WI_FC_NUM_RUNS=1..1000`
- timed profile duration: `WI_FUZZ_DURATION_MS=1000..86400000`
- local default: 60 seconds minimum fuzz budget
- extended default: 600 seconds minimum fuzz budget

See [property and fuzz testing](../testing/fuzzing.md) for reproduction and artifact behavior.
