# Wi v0.1 storage model

Status: canonical for the first vertical slice

## 1. Goals

The storage design must support:

- fast session listing without opening every session database
- one durable, self-contained database per session
- multiple sessions progressing concurrently
- exact event replay after browser or server interruption
- idempotent command handling
- durable approvals and pending questions
- crash recovery without cross-database atomic transactions
- lazy opening and bounded database-handle usage
- future export, backup, migration, and catalog reconstruction

## 2. Filesystem layout

```text
$WI_HOME/
├── catalog.sqlite3
├── sessions/
│   └── <two-character-prefix>/
│       └── <session-id>/
│           ├── session.sqlite3
│           └── artifacts/
├── logs/
└── tmp/
```

Rules:

- On first run, the configured `WI_HOME` directory chain is created synchronously with mode `0700` before any storage worker is constructed. Existing components are not moved, overwritten, deleted, or chmodded. The resulting directory is then canonicalized through its real path once at startup, so static symlink aliases converge before catalog or session paths are derived; a non-directory or inaccessible path fails with a bounded redacted storage error.
- The backend generates session paths; browser input never supplies them.
- Catalog paths are relative to `WI_HOME`.
- Session-directory prefixes are derived from session IDs to avoid oversized directories.
- Every test uses a unique temporary `WI_HOME`.
- Credentials are not stored in catalog or session databases.

## 3. Canonical ownership

The dedicated session database is canonical for one session.

The catalog database is a rebuildable index used to:

- list sessions
- map a session ID to a relative database path
- show lightweight status and attention counts
- locate sessions needing recovery or migration
- avoid opening every session database at startup

A successful session write never depends on a catalog write succeeding. The committed session result is returned to the caller before catalog observation completes, so publication can proceed immediately after commit. Catalog observations are independent and serialized per session. Each session retains at most one in-flight observation plus one coalesced latest dirty head; repeated commits never form an unbounded promise chain or retain every intermediate event array. The coalesced observer rereads the canonical session projection, so intermediate catalog work is safely skipped. A failed observation leaves the session database canonical and reports a diagnostic containing the session ID, attempted head sequence, and stable storage classification; diagnostic callback failures cannot replace or invalidate the committed result.

```text
session transaction commit
  -> publish committed session events
  -> update catalog summary asynchronously or immediately afterward
```

If the catalog update fails, the session remains valid and the catalog is reconciled later.

“Rebuildable” means that the session-index rows needed to locate and summarize sessions can be reconstructed from session manifests. Normal startup does not scan or open every session database. The Milestone 7 bounded session-directory scanner runs only for a new/missing catalog with surviving session directories or explicit `WI_CATALOG_REPAIR=1`; see [the failure and recovery matrix](failure-recovery-matrix.md). An existing catalog is first copied with its WAL/SHM sidecars to a private worker-owned probe directory. SQLite recovery, integrity checking, and migration validation run only against that disposable copy, with source directory and file identities checked before and after the copy probe. The manager and worker use a two-phase startup handshake: after validation, SQLite acquires the canonical handle with `fileMustExist`, then synchronously rechecks the prepared directory and DB/WAL/SHM path identities before any recovery-capable PRAGMA or query. This detects substitutions still visible at that check; it does not pin SQLite's acquired or lazily opened handles against a hostile process running as the same user. A missing catalog is reserved with final-component no-follow and no-overwrite creation, but parent components are trusted under [ADR-0012](../adr/0012-trusted-local-user-storage-boundary.md). Startup filesystem errors are reclassified into fixed bounded messages before worker RPC, so neither `WI_HOME` nor the private probe path is exposed. Ordinary validation failure leaves the canonical database and sidecars unopened and unchanged and startup fails closed. Node exposes no cross-platform handle-relative, no-follow, no-overwrite move that could safely clear a corrupt canonical path. With Wi stopped, an operator may restore the catalog or deliberately relocate it outside Wi; the next missing-catalog startup can then rebuild session-index rows.

Project registration metadata is different from session-index metadata. In v0.1, project names, canonical paths, realpaths, and configuration exist only in the catalog. After complete project-catalog loss, the supported recovery path is explicit project re-registration. A future project manifest may make that metadata independently recoverable.

## 4. Catalog schema responsibilities

Minimum catalog records:

```text
catalog_meta
projects
sessions
catalog_commands
```

### `projects`

Stores registered project metadata and canonical paths. The first slice may create one test project and does not yet expose real filesystem tools.

### `sessions`

Stores only summary/index data:

- session ID
- optional project ID
- database relative path
- title
- lifecycle status
- created and updated timestamps
- last event sequence
- last run state
- last message preview
- attention flag
- pending approval/input counts
- session schema version

### `catalog_commands`

Provides idempotency for global commands such as `session.create`, where no session database exists yet.

A catalog command stores:

- `command_id`
- method
- canonical payload hash
- current `creating`, `accepted`, or terminal `failed` state
- reserved session ID and path
- durable success or safe failure result
- failure category, safe message, diagnostic ID, and any retained historical quarantine path
- timestamps

## 5. Session database responsibilities

Every session database contains at least:

```text
manifest
events
accepted_commands
runs
messages
message_parts
provider_steps
tool_executions
approvals
pending_inputs
```

### `manifest`

Contains enough information to reconstruct the catalog entry:

- session ID
- project ID when present
- creation time
- schema version
- session-format version
- title
- last event sequence

### `events`

The canonical ordered history. Rows cannot be updated or deleted.

Representative schema:

```sql
CREATE TABLE events (
    sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    run_id TEXT,
    item_id TEXT,
    payload_json TEXT NOT NULL
) STRICT;
```

Triggers reject update and delete operations.

### `accepted_commands`

Provides session-scoped command idempotency.

It stores:

- command ID
- method
- canonical payload hash
- accepted event sequence
- run ID when applicable
- durable result JSON
- acceptance time

### Projection tables

`runs`, `messages`, `message_parts`, `provider_steps`, `tool_executions`, `approvals`, and `pending_inputs` are query-optimized projections maintained transactionally with events.

They are rebuildable from canonical events in principle, but Wi updates them during normal operation to avoid full-history replay for ordinary UI reads. Session schema version 3 adds `provider_steps.diagnostic_id`: terminal provider-step projections retain the diagnostic ID from their canonical failure event so a restart between step and run terminal commits preserves one causal identity.

## 6. Append-only meaning

Wi's event history is logically append-only:

- application code appends new events
- event rows are never updated
- event rows are never deleted
- corrections are represented by later events

SQLite's physical database and WAL files are not required to be physically append-only. Checkpoints, page reuse, and maintenance operations may rewrite database pages.

The guarantee is semantic and enforced by schema, triggers, repositories, and tests. Event payload compatibility is additive: retained failure payload v1 rows remain canonical and readable, while new safe failure payloads use v2. Browser safety is provided by a deterministic wire projection and never by rewriting legacy event rows.

## 7. Transaction boundary

One session mutation transaction performs:

```text
BEGIN IMMEDIATE
  -> verify command idempotency
  -> append one or more events
  -> update affected projections
  -> update manifest head
  -> persist command result when applicable
COMMIT
  -> publish committed events
```

Publication before commit is forbidden.

A crash:

- before commit leaves no visible durable mutation
- after commit but before publication is recovered by replay

## 8. Event sequencing

`sequence` is session-local and monotonically increasing.

The repository derives the next sequence under the session's serialized writer path. It does not accept a browser- or provider-supplied sequence.

Rules:

- no gaps are intentionally created by normal commits
- event IDs are globally unique but do not determine order
- the browser reducer applies events by sequence
- duplicate sequence delivery is ignored only when the event identity/content matches the already applied event
- conflicting content for an existing sequence is a fatal session integrity error

## 9. Database worker architecture

SQLite operations run in Node.js worker threads.

```text
main server thread
  ├── CatalogClient -> catalog worker
  └── SessionStoreClient -> fixed session worker pool
```

### Catalog worker

- owns the catalog connection
- processes validated RPC requests serially
- performs catalog migrations and reconciliation metadata updates

### Session worker pool

- has a bounded fixed size
- assigns a session consistently using a stable hash
- lazily opens session databases
- keeps an LRU cache of open handles
- serializes writes for each assigned session
- closes idle handles when capacity is exceeded

No worker is created per session.

## 10. Worker RPC

Worker messages use a versioned internal RPC envelope and runtime validation.

Every request carries:

- RPC version
- request ID
- operation name
- bounded payload
- relevant session ID
- trace identifiers when available

Every response carries:

- request ID
- success result or typed error
- worker ID
- optional diagnostic ID

A worker crash, malformed response, or request timeout rejects its in-flight requests, emits a diagnostic, and causes the supervisor to create a clean replacement after the old worker's termination is confirmed. If termination cannot be confirmed within the bounded deadline, that worker slot remains unavailable rather than risking overlapping database owners. Every RPC has a finite timeout and may also be aborted by its caller. A timed-out or aborted write is classified as having an ambiguous outcome: it is not retried automatically, and callers reconcile it by durable `commandId` or `eventId`. Worker close is bounded and settles all pending waiters. The web server remains alive unless storage-wide invariants can no longer be trusted.

Historical browser replay uses a dedicated page RPC rather than the unrestricted internal event-list API. Each page is limited inside the session worker by event count, complete serialized response bytes, and single-event bytes before `postMessage`. The page contract reserves a fixed byte allowance for both the page object and the versioned worker-RPC response envelope, so one event at the advertised single-event maximum always fits in a valid page. Live single-event capacity cannot exceed that historical capacity. The main thread validates and releases one page before requesting the next, and subscriber disconnect aborts the pending read RPC.

## 11. Session creation state machine

Session creation spans catalog and session databases without pretending to be one atomic transaction.

```text
1. Canonicalize and hash `session.create` command.
2. Reserve command, session ID, and generated path in catalog.
3. Create session directory.
4. Initialize and migrate session database.
5. Insert manifest and `session.created` event.
6. Commit session database.
7. Mark catalog session and command ready/accepted.
8. Acknowledge browser.
```

Recovery handles:

```text
catalog says creating + valid session DB exists
  -> inspect manifest and complete registration

catalog says creating + no DB exists
  -> retry initialization with the reserved identity

catalog says creating + corrupt or irreconcilable partial DB exists
  -> persist command state `failed`, retain a visible unavailable session row,
     and preserve the partial directory at its canonical path

session DB exists + no catalog row
  -> explicit catalog repair discovers it and reconstructs the session row from its manifest

catalog row exists + DB missing
  -> mark missing and report diagnostic
```

A duplicate `session.create` with the same command ID and payload returns its reserved, accepted, or terminal failed result. A corrupt partial database is never silently overwritten, and a failed reservation is not retried on every restart. A new command ID may reserve a new session identity explicitly.

## 12. Command idempotency

Canonical JSON is hashed with SHA-256.

For the same `commandId`:

```text
same method + same payload hash
  -> return stored result; do not execute again

different method or payload hash
  -> conflict; do not execute
```

A command acknowledgement is sent only after its acceptance record and related events commit.

This protects against:

- lost WebSocket acknowledgements
- browser retry after reconnect
- two tabs submitting the same command
- process death after commit but before reply

## 13. Catalog reconciliation

The reconciler compares catalog summary data with session manifests and heads.

For a catalog row already in `ready`, ordinary reconciliation may repair:

- last event sequence
- title and preview
- pending attention counts
- schema version
- orphaned session entries

It never rewrites canonical session events. Catalog status is authoritative at the storage boundary: normal open, read, recovery, command acceptance, and append paths reject `unavailable` or `missing` rows and close any retained lazy handle. Per-session coordination shared by catalog clients for the same canonical home serializes status transitions with manager-created client use; existing homes are realpath-canonicalized before the coordinator key, catalog path, and manager session paths are derived, so static ancestor aliases cannot split the boundary. A read or mutation holds that coordination boundary from its final readiness check through the session-worker response; a competing status transition waits for earlier work and blocks later work, which must recheck the committed status. Generic reconciliation requires an existing trusted `ready` row and cannot insert an absent row or promote `unavailable` or `missing` to `ready`. During reconciliation, an absent row may be reconstructed only by the module-internal incomplete-creation capability after a durable `creating` reservation, or by the bounded repair scanner's separate internal capability after complete worker-contained path, manifest, schema, size, creation-provenance, and projection validation. The capability is a module-closure operation backed by a `WeakMap`; it is absent from `CatalogClient` instance fields and prototype symbols. `SessionStoreManager` keeps its worker pool in a JavaScript private field, `SessionClient` keeps its pool and hooks in JavaScript private fields, and the normal `@wi/storage` runtime entry point exports neither class. Test fixtures use a separate internal, `NODE_ENV=test`-gated accessor that is not a package export. Hookless worker access and validated promotion are therefore not public catalog or session mutation modes.

Reconciliation runs:

- at startup for catalog commands already known to be incomplete
- when opening a catalog-known session whose summary appears stale
- through an explicit maintenance operation

Ordinary startup intentionally does not walk `$WI_HOME/sessions`. The bounded complete-discovery scanner is used only when catalog repair is required. Fresh catalog schema initialization atomically includes a catalog-local repair marker, which is cleared only after complete reconciliation and creation-command restoration, so a crash during reconstruction triggers another idempotent scan. The worker streams bounded directory entries into a compact session-ID inventory, then returns database-derived records through bounded pages from a read-only non-migrating reader. Discovery error codes and messages are truncated to fixed limits before worker serialization and validated again on receipt. The manager retains only compact creation-command ownership and constant-size fault classifications between its provenance and reconciliation passes; full records and diagnostic text remain page-scoped rather than accumulating in main-thread memory. The scanner validates the exact generated layout and symlink/realpath/file-identity boundaries, reconstructs session-index data, and marks proven structural corruption unavailable without blocking healthy sessions. Corrupt session storage is preserved in place because Node does not expose a cross-platform handle-relative directory rename; Wi never substitutes a pathname-based rename that could follow a swapped ancestor. Repair also performs a bounded catalog complement pass. The manager keeps the already bounded discovered-ID set locally, reads lightweight catalog status/provenance records in pages of at most 1,000, and submits missing path repairs in bounded batches; it never sends the complete 10,000-ID inventory through one worker RPC. A catalog session ID not represented by discovery is marked `missing`, including when its entire generated directory is absent. Existing `missing` and explicitly quarantined `unavailable` classifications are preserved. Unsupported and oversized rows are unavailable only while their canonical database remains present; deleting that preserved file or directory makes the next explicit repair classify the row as `missing`. Reconstruction applies canonical manifest/path data and the same event-sequence-derived update time, run state, and 200-character message preview as normal catalog observation. A newer unsupported session schema or a database file above the 256 MiB discovery budget is marked unavailable, preserved in place, and does not retain installation-wide repair intent. Every discovery classification repairs the catalog to the strict generated database path. A missing database preserves any existing catalog-only metadata and remaining directory while changing only the path and status to `missing`; corrupt and unsupported classifications likewise preserve existing metadata while applying their fault status and observed schema information. Operational scanner errors retain repair intent for a later restart. Normal session creation and recovery use one matching default 1,000-session installation bound; production can intentionally raise both to at most 10,000 with `WI_SESSION_DISCOVERY_LIMIT`, preventing normal writes from creating a catalog that its configured scanner cannot enumerate. Project metadata still requires re-registration in v0.1.

## 14. SQLite configuration

Each connection should configure at minimum:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;
```

The exact adapter is internal to `packages/storage`. The first plan recommends `better-sqlite3`, but callers depend only on Wi repositories and clients.

Databases are expected on local storage. Network filesystems are outside the supported v0.1 boundary.

## 15. Migrations

Catalog and session databases have separate migration sequences. The version-by-version operator guide is [`docs/reference/migrations.md`](../reference/migrations.md).

Requirements:

- schema version stored explicitly
- deterministic ordered migrations
- tests from every retained prior version
- no eager opening/migration of every session database at server startup
- session migration occurs when that session is opened or through explicit maintenance
- a failed session migration marks only that session unavailable and preserves it in place
- a failed catalog migration prevents normal server startup because session discovery cannot be trusted

The first vertical slice begins at schema version 1 but still implements the migration framework. The current session schema is version 4; migrations from retained v1/v2 databases add tool-call occurrences and provider-step diagnostic IDs transactionally without rewriting canonical events. Version 4 adds immutable creation provenance for newly initialized sessions, allowing catalog reconstruction to restore a lost `session.create` idempotency record. A process regression constructs a populated database from the frozen exact v3 schema emitted by commit `1b9c4f0`, verifies transactional migration and unchanged raw events, and proves an injected v4 failure leaves a readable version-3 database that succeeds once the injection is removed. Retained v1-v3 databases may rebuild their session rows but cannot safely reconstruct an already-lost creation command ID. Catalog schema version 5 adds nullable unavailable provenance. The `quarantined` value remains readable for databases produced by earlier binaries, but the current path-safe policy does not create new session-directory quarantine provenance: corrupt, unsupported, oversized, and other unavailable rows are preserved in place with null provenance. Repair clears historical provenance whenever a row becomes ready or missing.

## 16. Recovery states

At startup, unfinished projections are interpreted conservatively:

```text
provider step marked streaming
  -> interrupted

run marked running with no resumable active task
  -> interrupted or waiting, based on latest durable state

pending approval/input
  -> remain pending

tool marked started with no result
  -> reconcile according to effect class

completed run
  -> remain completed
```

The first slice's pure tools may safely retry only under the ledger policy defined in ADR-0008.

## 17. Artifacts and large payloads

Large outputs should not be stored repeatedly inside event JSON.

A later artifact layer may store content-addressed blobs beneath the session's `artifacts/` directory. Events then contain:

- artifact/blob ID
- content type
- byte length
- preview
- integrity hash

The first slice can keep outputs small but should preserve the abstraction boundary.

## 18. Backup and export

A future session export must use a consistent SQLite backup or snapshot operation and optionally include session artifacts. No production export API, UI, or backup command is implemented in this slice; the stopped-filesystem backup limitation is documented in [`docs/reference/migrations.md`](../reference/migrations.md).

It never includes:

- API keys
- OAuth tokens
- browser session secrets
- [`CredentialStore`](../adr/0014-wsl-file-credential-store.md) material, which is outside `WI_HOME` and its backup/export boundary beginning in Milestone 11 (the released v0.1 product has no provider credential store)

Session-index rows are rebuildable from discovered session manifests, but project registration metadata is not independently reconstructable in v0.1. A complete installation backup should therefore include both catalog and session directories.

## 19. Failure tests

Process-level tests must cover:

- death before session commit
- death after session commit but before catalog update
- death after commit but before publication
- death during session creation
- database worker death during a request
- stale catalog reconciliation
- corrupt or missing session database handling
- disk-full or write-failure simulation where practical
- too many open session handles and LRU eviction

The core assertion is always:

```text
browser-visible durable state == committed session database state
```
